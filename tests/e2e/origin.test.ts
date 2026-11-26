import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { browserUrl, deploy, folder, visit } from "../helpers/site";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

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

async function originOf(files: Record<string, string | Buffer>, flags: string[] = []): Promise<{ origin: string; link: string }> {
  const { url } = await deploy(["--no-copy", ...flags, folder(files)]);
  const link = browserUrl(url);
  return { origin: new URL(link).origin, link };
}

async function openEmbedder(): Promise<Page> {
  const { origin } = await originOf({ "index.html": "<!doctype html><title>Elsewhere</title><h1>Elsewhere</h1>" });
  const page = await newPage();
  await page.goto(`${origin}/`);
  return page;
}

test("another origin reads a site's files with fetch, credentials, custom headers, ranges and timing", async () => {
  const data = JSON.stringify({ ok: true });
  const { origin: site } = await originOf({ "index.html": "<h1>Data</h1>", "data.json": data, "notes.bin": "0123456789".repeat(10) });
  const page = await openEmbedder();

  const results = await page.evaluate(async (site) => {
    const read = async (init: { credentials?: string; headers?: Record<string, string> }) => {
      try {
        const response = await fetch(`${site}/data.json`, init as RequestInit);
        return { status: response.status, body: await response.text() };
      } catch (error) {
        return { status: 0, body: String(error) };
      }
    };
    const plain = await read({});
    const credentialed = await read({ credentials: "include" });
    const customHeader = await read({ headers: { "X-Requested-With": "XMLHttpRequest" } });
    const json = await read({ headers: { "Content-Type": "application/json" } });
    const range = await fetch(`${site}/notes.bin`, { headers: { Range: "bytes=5-14" } });
    const rangeBody = await range.text();
    let entries: PerformanceResourceTiming[] = [];
    for (let attempt = 0; attempt < 50 && entries.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      entries = performance.getEntriesByName(`${site}/data.json`) as PerformanceResourceTiming[];
    }
    return {
      plain,
      credentialed,
      customHeader,
      json,
      range: { status: range.status, body: rangeBody, contentRange: range.headers.get("content-range"), acceptRanges: range.headers.get("accept-ranges"), etag: range.headers.get("etag") },
      timed: entries.length > 0 && entries.every((entry) => entry.responseStart > 0)
    };
  }, site);

  assert.deepEqual(results.plain, { status: 200, body: data });
  assert.deepEqual(results.credentialed, { status: 200, body: data }, "a credentialed fetch from another origin works");
  assert.deepEqual(results.customHeader, { status: 200, body: data }, "a preflighted fetch from another origin works");
  assert.deepEqual(results.json, { status: 200, body: data });
  assert.equal(results.range.status, 206);
  assert.equal(results.range.body, "5678901234");
  assert.equal(results.range.contentRange, "bytes 5-14/100", "another origin can read Content-Range");
  assert.equal(results.range.acceptRanges, "bytes");
  assert.match(results.range.etag ?? "", /-2"$/);
  assert.equal(results.timed, true, "another origin sees resource timing");
  await page.context().close();
});

test("another origin uses a site's fonts, module scripts, canvas images and stylesheets", async () => {
  const undecodableFont = Buffer.from("d09GMgABAAAAAAA", "base64");
  const { origin: site } = await originOf({
    "index.html": "<h1>Assets</h1>",
    "pixel.png": pixel,
    "module.js": "export const answer = 42;",
    "style.css": "h1{color:rgb(0, 128, 0)}",
    "font.woff2": undecodableFont
  });
  const probe = `
    const site = ${JSON.stringify(site)};
    const canvasReadable = (crossOrigin) => new Promise((resolve) => {
      const image = new Image();
      image.crossOrigin = crossOrigin;
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.getContext("2d").drawImage(image, 0, 0);
        try { canvas.toDataURL(); resolve("readable"); } catch { resolve("tainted"); }
      };
      image.onerror = () => resolve("failed");
      image.src = site + "/pixel.png?" + crossOrigin;
    });
    const moduleLoads = (crossOrigin) => new Promise((resolve) => {
      const script = document.createElement("script");
      script.type = "module";
      script.crossOrigin = crossOrigin;
      script.src = site + "/module.js?" + crossOrigin;
      script.onload = () => resolve("loaded");
      script.onerror = () => resolve("failed");
      document.head.append(script);
    });
    const stylesheetLoads = (crossOrigin) => new Promise((resolve) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.crossOrigin = crossOrigin;
      link.href = site + "/style.css?" + crossOrigin;
      link.onload = () => { try { resolve("rules:" + link.sheet.cssRules.length); } catch { resolve("unreadable"); } };
      link.onerror = () => resolve("failed");
      document.head.append(link);
    });
    const fontLoads = async () => {
      const face = new FontFace("Remote", "url(" + site + "/font.woff2)");
      try { await face.load(); return "loaded"; } catch (error) { return error.name; }
    };
    (async () => {
      window.results = {
        anonymousCanvas: await canvasReadable("anonymous"),
        credentialedCanvas: await canvasReadable("use-credentials"),
        anonymousModule: await moduleLoads("anonymous"),
        credentialedModule: await moduleLoads("use-credentials"),
        anonymousSheet: await stylesheetLoads("anonymous"),
        credentialedSheet: await stylesheetLoads("use-credentials"),
        font: await fontLoads()
      };
    })();`;
  const { link } = await originOf({ "index.html": `<!doctype html><h1>Elsewhere</h1><script>${probe}</script>` });
  const page = await newPage();
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  await page.goto(link);
  await page.waitForFunction("window.results !== undefined");
  const results: unknown = await page.evaluate("window.results");

  assert.deepEqual(results, {
    anonymousCanvas: "readable",
    credentialedCanvas: "readable",
    anonymousModule: "loaded",
    credentialedModule: "loaded",
    anonymousSheet: "rules:1",
    credentialedSheet: "rules:1",
    font: "NetworkError"
  });
  assert.ok(
    consoleMessages.some((message) => /decode downloaded font|OTS parsing error/.test(message)),
    "the font bytes reached the font decoder"
  );
  assert.ok(!consoleMessages.some((message) => /CORS/.test(message)), consoleMessages.join("\n"));
  await page.context().close();
});

test("a cross-origin isolated page elsewhere can still embed a site's images", async () => {
  const { origin: site } = await originOf({ "index.html": "<h1>Images</h1>", "pixel.png": pixel });
  const isolated = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" });
    response.end(`<!doctype html><h1>Isolated</h1><img id="remote" src="${site}/pixel.png">`);
  });
  await new Promise<void>((resolve) => isolated.listen(0, "127.0.0.1", resolve));
  const page = await newPage();
  try {
    await page.goto(`http://127.0.0.1:${(isolated.address() as AddressInfo).port}/`);
    assert.equal(await page.evaluate("crossOriginIsolated"), true);
    await page.waitForFunction(`document.getElementById("remote").complete`);
    assert.equal(await page.evaluate(`document.getElementById("remote").naturalWidth`), 1);
  } finally {
    await page.context().close();
    isolated.close();
  }
});

test("an encrypted site opens inside an iframe on another origin", async () => {
  const { link } = await originOf({ "index.html": "<h1>Private framed</h1>" }, ["-e"]);
  const embedder = await originOf({ "index.html": `<!doctype html><h1>Elsewhere</h1><iframe src="${link}"></iframe>` });
  const page = await newPage();
  await page.goto(embedder.link);
  const origin = new URL(link).origin;
  let found = false;
  for (let attempt = 0; attempt < 100 && !found; attempt += 1) {
    const frame = page.frames().find((candidate) => candidate.url().startsWith(origin));
    const text = await frame?.textContent("h1").catch(() => null);
    found = text === "Private framed";
    if (!found) await page.waitForTimeout(100);
  }
  assert.ok(found, "the private page decrypted inside the frame");
  await page.context().close();
});

test("an encrypted site whose own service worker cannot register still opens", async () => {
  const html = `<h1>Own worker</h1><p id="worker">pending</p><script>navigator.serviceWorker.register("/sw.js").then(() => { document.getElementById("worker").textContent = "registered"; }, () => { document.getElementById("worker").textContent = "refused"; });</script>`;
  const { link } = await originOf({ "index.html": html, "sw.js": "self.addEventListener('fetch', () => {})" }, ["-e"]);
  const page = await newPage();
  await page.goto(link);
  await page.waitForSelector("text=Own worker");
  await page.waitForFunction(`document.getElementById("worker").textContent !== "pending"`);
  assert.equal(await page.textContent("#worker"), "refused");
  await page.reload();
  await page.waitForSelector("text=Own worker");
  await page.context().close();
});

test("a preflight to a site is answered and other writes stay refused", async () => {
  const { origin } = await originOf({ "index.html": "<h1>Read only</h1>" });
  const host = `https://${new URL(origin).hostname}`;
  const preflight = await visit(host, "/index.html", {
    method: "OPTIONS",
    headers: { origin: "https://elsewhere.example", "access-control-request-method": "GET", "access-control-request-headers": "x-requested-with, authorization" }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "https://elsewhere.example");
  assert.equal(preflight.headers["access-control-allow-credentials"], "true");
  assert.match(String(preflight.headers["access-control-allow-methods"]), /GET/);
  assert.equal(preflight.headers["access-control-allow-headers"], "x-requested-with, authorization");
  const post = await visit(host, "/index.html", { method: "POST", headers: { origin: "https://elsewhere.example" } });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, preflight.headers.allow);
  assert.equal(post.headers.allow, "GET, HEAD, OPTIONS");
});
