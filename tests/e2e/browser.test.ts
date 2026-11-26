import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { browserUrl, deploy, folder, newHome, runCli, uniqueName } from "../helpers/site";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const bigFile = randomBytes(2.5 * 1024 * 1024);

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

async function newPage(): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

const storeScript = (action: string) => `new Promise((resolve, reject) => {
  const opening = indexedDB.open("site", 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore("keys");
  opening.onerror = () => reject(opening.error);
  opening.onsuccess = () => {
    const store = opening.result.transaction("keys", "readwrite").objectStore("keys");
    const request = ${action};
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  };
})`;

async function storedKeyEntry(page: Page): Promise<unknown> {
  return page.evaluate(`${storeScript(`store.get("link")`)}.then((value) => {
    if (typeof value === "string") return value;
    if (value === undefined) return "missing";
    return { type: value.base.constructor.name, extractable: value.base.extractable, fingerprint: typeof value.fingerprint };
  })`);
}

async function storeKeyText(page: Page, key: string): Promise<void> {
  await page.evaluate(storeScript(`store.put(${JSON.stringify(key)}, "link")`));
}

async function waitForHeading(page: Page, text: string): Promise<void> {
  await page.waitForFunction(`document.querySelector("h1")?.textContent === ${JSON.stringify(text)}`);
}

test("an encrypted link opens the whole site in a browser", async () => {
  const root = folder({
    "index.html": `<!doctype html><link rel="stylesheet" href="/style.css"><script src="/app.js"></script><h1>Private home</h1><img id="logo" src="/logo.png"><a href="/about">About</a>`,
    "style.css": `h1{color:rgb(255, 0, 0)}${"\n.unused{margin:0}".repeat(200)}`,
    "app.js": "document.documentElement.dataset.script = 'ran'",
    "logo.png": pixel,
    "about.html": "<h1>About page</h1>",
    "docs/index.html": "<h1>Docs</h1>",
    "404.html": "<h1>Lost here</h1>",
    "big.bin": bigFile
  });
  const { url } = await deploy(["--no-copy", "-e", root]);
  const origin = new URL(browserUrl(url)).origin;
  const page = await newPage();

  await page.goto(browserUrl(url));
  await waitForHeading(page, "Private home");
  assert.equal(page.url(), `${origin}/`, "the key leaves the address bar");
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector("h1")).color`), "rgb(255, 0, 0)");
  assert.equal(await page.evaluate("document.documentElement.dataset.script"), "ran");
  await page.waitForFunction(`document.getElementById("logo").naturalWidth === 1`);

  await page.click("a");
  await waitForHeading(page, "About page");
  assert.equal(page.url(), `${origin}/about`);

  await page.goto(`${origin}/docs`);
  await waitForHeading(page, "Docs");
  assert.equal(page.url(), `${origin}/docs/`);

  const missing = await page.goto(`${origin}/nowhere`);
  assert.equal(missing?.status(), 404);
  await waitForHeading(page, "Lost here");

  const ranges = await page.evaluate(async () => {
    const read = async (range: string) => {
      const response = await fetch("/big.bin", { headers: { Range: range } });
      return { status: response.status, contentRange: response.headers.get("content-range"), bytes: [...new Uint8Array(await response.arrayBuffer())] };
    };
    const whole = await fetch("/big.bin");
    return {
      across: await read("bytes=1048570-1048600"),
      tail: await read("bytes=-5"),
      late: await read("bytes=2097152-2097161"),
      wholeLength: (await whole.arrayBuffer()).byteLength,
      wholeType: whole.headers.get("content-type")
    };
  });
  assert.equal(ranges.across.status, 206);
  assert.equal(ranges.across.contentRange, `bytes 1048570-1048600/${bigFile.byteLength}`);
  assert.deepEqual(ranges.across.bytes, [...bigFile.subarray(1048570, 1048601)]);
  assert.deepEqual(ranges.tail.bytes, [...bigFile.subarray(bigFile.byteLength - 5)]);
  assert.deepEqual(ranges.late.bytes, [...bigFile.subarray(2097152, 2097162)]);
  assert.equal(ranges.wholeLength, bigFile.byteLength);
  assert.equal(ranges.wholeType, "application/octet-stream");

  await page.goto(`${origin}/`);
  await waitForHeading(page, "Private home");
  await page.reload();
  await waitForHeading(page, "Private home");

  const session = await page.context().newCDPSession(page);
  let bootLoads = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/__site/boot.js")) bootLoads += 1;
  });
  await session.send("Page.reload", { ignoreCache: true });
  await page.waitForLoadState("load");
  await waitForHeading(page, "Private home");
  assert.ok(bootLoads >= 1, "the hard reload went through the bootstrap page");

  await session.send("ServiceWorker.enable");
  await session.send("ServiceWorker.stopAllWorkers");
  await page.goto(`${origin}/about`);
  await waitForHeading(page, "About page");
  await page.context().close();
});

test("a named encrypted site shows a redeploy on the next navigation", async () => {
  const home = newHome();
  const name = uniqueName("live");
  const first = await deploy(["--no-copy", "-e", "-n", name, folder({ "index.html": "<h1>Version one</h1>" })], { home });
  const page = await newPage();
  await page.goto(browserUrl(first.url));
  await waitForHeading(page, "Version one");

  const second = await deploy(["--no-copy", "-e", "-n", name, folder({ "index.html": "<h1>Version two</h1>" })], { home });
  assert.equal(second.url, first.url);
  await page.goto(new URL(browserUrl(first.url)).origin);
  await waitForHeading(page, "Version two");
  await page.context().close();
});

test("--spa serves index.html for routes inside an encrypted site", async () => {
  const { url } = await deploy(["--no-copy", "-e", "--spa", folder({ "index.html": "<h1>App shell</h1>", "app.js": "boot()" })]);
  const origin = new URL(browserUrl(url)).origin;
  const page = await newPage();
  await page.goto(browserUrl(url));
  await waitForHeading(page, "App shell");

  const route = await page.goto(`${origin}/projects/42`);
  assert.equal(route?.status(), 200);
  await waitForHeading(page, "App shell");
  const missing = await page.goto(`${origin}/missing.js`);
  assert.equal(missing?.status(), 404);
  await page.context().close();
});

test("without the key the site says it is private, and a wrong key says so", async () => {
  const { url } = await deploy(["--no-copy", "-e", folder({ "index.html": "<h1>Secret</h1>" })]);
  const origin = new URL(browserUrl(url)).origin;

  const keyless = await newPage();
  await keyless.goto(`${origin}/`);
  await keyless.waitForSelector("text=This site is private");
  assert.equal(await keyless.isVisible("text=Secret"), false);
  await keyless.goto(browserUrl(url));
  await keyless.waitForSelector("text=Secret");
  assert.equal(keyless.url(), `${origin}/`);
  await keyless.context().close();

  const wrong = await newPage();
  await wrong.goto(`${origin}/#${randomBytes(32).toString("base64url")}`);
  await wrong.waitForSelector("text=This key does not open this site");
  assert.equal(wrong.url(), `${origin}/`);
  await wrong.reload();
  await wrong.waitForSelector("text=This site is private");
  await wrong.goto(browserUrl(url));
  await wrong.waitForSelector("text=Secret");
  await wrong.context().close();
});

test("scripts on an opened private site cannot read the link key", async () => {
  const { url } = await deploy(["--no-copy", "-e", folder({ "index.html": "<h1>Guarded</h1>" })]);
  const key = new URL(url).hash.slice(1);
  const page = await newPage();
  await page.goto(browserUrl(url));
  await waitForHeading(page, "Guarded");

  assert.deepEqual(await storedKeyEntry(page), { type: "CryptoKey", extractable: false, fingerprint: "string" });
  const leaked = await page.evaluate(`${storeScript(`store.getAll()`)}.then(async (values) => {
    const found = [];
    for (const value of values) {
      found.push(JSON.stringify(value));
      for (const format of ["raw", "jwk"]) {
        try {
          const exported = await crypto.subtle.exportKey(format, value.base);
          found.push(JSON.stringify(exported), btoa(String.fromCharCode(...new Uint8Array(exported))));
        } catch {}
      }
    }
    return found.join(" ");
  })`);
  assert.equal(String(leaked).includes(key), false, "the key text never comes out of storage");
  assert.equal(String(leaked).includes(Buffer.from(key, "base64url").toString("base64")), false);
  await page.context().close();
});

test("a visitor whose key was stored as text still opens the site", async () => {
  const { url } = await deploy(["--no-copy", "-e", folder({ "index.html": '<h1>Kept</h1><a href="/about">About</a>', "about.html": "<h1>About kept</h1>" })]);
  const key = new URL(url).hash.slice(1);
  const origin = new URL(browserUrl(url)).origin;

  const fresh = await newPage();
  await fresh.goto(`${origin}/`);
  await fresh.waitForSelector("text=This site is private");
  await storeKeyText(fresh, key);
  await fresh.reload();
  await waitForHeading(fresh, "Kept");
  assert.deepEqual(await storedKeyEntry(fresh), { type: "CryptoKey", extractable: false, fingerprint: "string" });

  await storeKeyText(fresh, key);
  const session = await fresh.context().newCDPSession(fresh);
  await session.send("ServiceWorker.enable");
  await session.send("ServiceWorker.stopAllWorkers");
  await fresh.click("a");
  await waitForHeading(fresh, "About kept");
  assert.deepEqual(await storedKeyEntry(fresh), { type: "CryptoKey", extractable: false, fingerprint: "string" });
  await fresh.context().close();
});

test("the stored key is deleted once the name points at a public deploy", async () => {
  const home = newHome();
  const name = uniqueName("unlocked");
  const { url } = await deploy(["--no-copy", "-e", "-n", name, folder({ "index.html": "<h1>Private first</h1>" })], { home });
  const origin = new URL(browserUrl(url)).origin;
  const page = await newPage();
  await page.goto(browserUrl(url));
  await waitForHeading(page, "Private first");

  const released = await runCli(["rm", name], { home });
  assert.equal(released.code, 0, released.stderr);
  await deploy(["--no-copy", "-n", name, folder({ "index.html": "<h1>Public now</h1>" })], { home });
  await page.goto(`${origin}/`);
  await waitForHeading(page, "Public now");
  assert.equal(await storedKeyEntry(page), "missing");
  assert.equal(await page.evaluate("navigator.serviceWorker.getRegistration().then((registration) => registration === undefined)"), true);
  await page.context().close();
});

test("after --new-link the old link shows the wrong-key page and forgets the stored key, and the new link opens the site", async () => {
  const home = newHome();
  const name = uniqueName("relink");
  const old = await deploy(["--no-copy", "-e", "-n", name, folder({ "index.html": "<h1>Before</h1>" })], { home });
  const origin = new URL(browserUrl(old.url)).origin;
  const visitor = await newPage();
  await visitor.goto(browserUrl(old.url));
  await waitForHeading(visitor, "Before");

  const replaced = await deploy(["--no-copy", "-e", "-n", name, "--new-link", folder({ "index.html": "<h1>After</h1>" })], { home });
  await visitor.goto("about:blank");
  await visitor.goto(browserUrl(old.url));
  await visitor.waitForSelector("text=This key does not open this site");
  assert.equal(visitor.url(), `${origin}/`);
  assert.equal(await storedKeyEntry(visitor), "missing");
  await visitor.goto(`${origin}/`);
  await visitor.waitForSelector("text=This site is private");
  await visitor.goto(browserUrl(replaced.url));
  await waitForHeading(visitor, "After");
  await visitor.context().close();

  const stranger = await newPage();
  await stranger.goto(browserUrl(old.url));
  await stranger.waitForSelector("text=This key does not open this site");
  await stranger.context().close();
});
