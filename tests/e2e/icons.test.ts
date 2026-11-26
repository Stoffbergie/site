import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { browserUrl, deploy, folder, hostOf, newHome, uniqueName, visit } from "../helpers/site";

const ownIcon = randomBytes(900);
const icoHeaderBytes = 22;

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

type Picture = { size: number; pixel: (x: number, y: number) => number[] };

function readPng(png: Buffer): Picture {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.subarray(12, 16).toString(), "IHDR");
  const size = png.readUInt32BE(16);
  assert.equal(png.readUInt32BE(20), size);
  assert.deepEqual([...png.subarray(24, 26)], [8, 6]);
  const dataLength = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString(), "IDAT");
  const rows = inflateSync(png.subarray(41, 41 + dataLength));
  const stride = 1 + size * 4;
  assert.equal(rows.byteLength, size * stride);
  return {
    size,
    pixel: (x, y) => [...rows.subarray(y * stride + 1 + x * 4, y * stride + 5 + x * 4)]
  };
}

function readIco(ico: Buffer): Picture {
  assert.deepEqual([...ico.subarray(0, 6)], [0, 0, 1, 0, 1, 0]);
  assert.equal(ico.readUInt32LE(14), ico.byteLength - icoHeaderBytes);
  assert.equal(ico.readUInt32LE(18), icoHeaderBytes);
  return readPng(ico.subarray(icoHeaderBytes));
}

test("a site without an icon gets one drawn for it, the same every time", async () => {
  const { url } = await deploy(["--no-copy", folder({ "index.html": "<h1>Home</h1>", "404.html": "<h1>Lost</h1>" })]);

  const icon = await visit(url, "/favicon.ico");
  assert.equal(icon.status, 200);
  assert.equal(icon.headers["content-type"], "image/x-icon");
  assert.equal(icon.headers["cache-control"], "no-cache, no-transform");
  assert.equal(icon.headers["access-control-allow-origin"], "*");
  assert.equal(Number(icon.headers["content-length"]), icon.body.byteLength);
  const picture = readIco(icon.body);
  assert.equal(picture.size, 64);
  assert.equal(picture.pixel(0, 0)[3], 0, "the corners are rounded off");
  const tile = picture.pixel(32, 2);
  assert.equal(tile[3], 255);
  assert.notDeepEqual(tile.slice(0, 3), [255, 255, 255]);
  const colors = new Set<string>();
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const [red, green, blue, alpha] = picture.pixel(x, y);
      if (alpha === 255) colors.add(`${red},${green},${blue}`);
    }
  }
  assert.deepEqual([...colors].sort(), ["255,255,255", tile.slice(0, 3).join(",")].sort(), "a pattern in white on one colour");

  assert.deepEqual((await visit(url, "/favicon.ico")).body, icon.body);
  const revalidated = await visit(url, "/favicon.ico", { headers: { "if-none-match": icon.headers.etag as string } });
  assert.equal(revalidated.status, 304);
  const head = await visit(url, "/favicon.ico", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.byteLength, 0);

  for (const path of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) {
    const touch = await visit(url, path);
    assert.equal(touch.status, 200, path);
    assert.equal(touch.headers["content-type"], "image/png", path);
    const square = readPng(touch.body);
    assert.equal(square.size, 180, path);
    assert.deepEqual(square.pixel(0, 0), [...tile.slice(0, 3), 255], path);
  }

  const { url: other } = await deploy(["--no-copy", folder({ "index.html": "<h1>Other</h1>" })]);
  assert.notDeepEqual((await visit(other, "/favicon.ico")).body, icon.body);
  assert.equal((await visit(url, "/assets/favicon.ico")).status, 404);
});

test("a named site keeps its drawn icon across redeploys", async () => {
  const home = newHome();
  const name = uniqueName("icon");
  const { url } = await deploy(["--no-copy", "-n", name, folder({ "index.html": "<h1>One</h1>" })], { home });
  const first = await visit(url, "/favicon.ico");
  await deploy(["--no-copy", "-n", name, folder({ "index.html": "<h1>Two</h1>" })], { home });
  const second = await visit(url, "/favicon.ico");
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);

  await deploy(["--no-copy", "-n", name, folder({ "index.html": "<h1>Three</h1>", "favicon.ico": ownIcon })], { home });
  const own = await visit(url, "/favicon.ico", { headers: { "if-none-match": first.headers.etag as string } });
  assert.equal(own.status, 200);
  assert.deepEqual(own.body, ownIcon);
});

test("a site's own icon files come before a drawn one", async () => {
  const { url: withIco } = await deploy(["--no-copy", folder({ "index.html": "<h1>Home</h1>", "favicon.ico": ownIcon, "favicon.png": randomBytes(300) })]);
  assert.deepEqual((await visit(withIco, "/favicon.ico")).body, ownIcon);

  const { url: withPng } = await deploy(["--no-copy", folder({ "index.html": "<h1>Home</h1>", "favicon.png": ownIcon })]);
  const standIn = await visit(withPng, "/favicon.ico");
  assert.equal(standIn.status, 200);
  assert.equal(standIn.headers["content-type"], "image/png");
  assert.deepEqual(standIn.body, ownIcon);
  assert.deepEqual((await visit(withPng, "/apple-touch-icon.png")).body, ownIcon);

  const { url: withSvg } = await deploy(["--no-copy", folder({ "index.html": "<h1>Home</h1>", "icon.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>" })]);
  const vector = await visit(withSvg, "/favicon.ico");
  assert.equal(vector.headers["content-type"], "image/svg+xml");
  assert.match(vector.text, /<svg/);
  assert.equal((await visit(withSvg, "/apple-touch-icon.png")).headers["content-type"], "image/png", "a home-screen icon is never an SVG");
});

test("a redirect rule for the icon path wins over the drawn icon", async () => {
  const { url } = await deploy(["--no-copy", folder({ "index.html": "<h1>Home</h1>", "brand/mark.png": ownIcon, _redirects: "/favicon.ico /brand/mark.png 200\n/apple-touch-icon.png /gone 404\n" })]);
  const rewritten = await visit(url, "/favicon.ico");
  assert.equal(rewritten.status, 200);
  assert.deepEqual(rewritten.body, ownIcon);
  assert.equal((await visit(url, "/apple-touch-icon.png")).status, 404);

  const { url: cached } = await deploy(["--no-copy", folder({ "index.html": "<h1>Home</h1>", _headers: "/*\n  Cache-Control: public, max-age=31536000, immutable\n  X-Mark: yes\n" })]);
  const drawn = await visit(cached, "/favicon.ico");
  assert.equal(drawn.headers["x-mark"], "yes");
  assert.equal(drawn.headers["cache-control"], "no-cache, no-transform", "a drawn icon is always revalidated");
});

async function iconSeenBy(page: Page): Promise<{ status: number; type: string | null; bytes: number[] }> {
  return page.evaluate(
    `fetch("/favicon.ico").then(async (response) => ({ status: response.status, type: response.headers.get("content-type"), bytes: [...new Uint8Array(await response.arrayBuffer())] }))`
  );
}

test("a private site shows a drawn icon until its own one can be read", async () => {
  const { url: bare } = await deploy(["--no-copy", "-e", folder({ "index.html": "<h1>Private home</h1>" })]);
  const beforeTheKey = await visit(hostOf(bare), "/favicon.ico");
  assert.equal(beforeTheKey.status, 200);
  assert.equal(beforeTheKey.headers["content-type"], "image/x-icon");
  assert.equal(beforeTheKey.headers["cache-control"], "no-cache, no-transform");
  assert.equal(readIco(beforeTheKey.body).size, 64);
  assert.equal(readPng((await visit(hostOf(bare), "/apple-touch-icon.png")).body).size, 180);
  const asPage = await visit(hostOf(bare), "/favicon.ico", { headers: { "sec-fetch-dest": "document" } });
  assert.equal(asPage.headers["x-site-bootstrap"], "1", "a link to the icon path still opens through the bootstrap");

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(browserUrl(bare));
  await page.waitForFunction(`document.querySelector("h1")?.textContent === "Private home"`);
  const drawn = await iconSeenBy(page);
  assert.equal(drawn.status, 200);
  assert.equal(drawn.type, "image/x-icon");
  assert.deepEqual(Buffer.from(drawn.bytes), beforeTheKey.body);

  const { url: branded } = await deploy(["--no-copy", "-e", folder({ "index.html": "<h1>Branded home</h1>", "favicon.ico": ownIcon })]);
  const brandedPage = await context.newPage();
  await brandedPage.goto(browserUrl(branded));
  await brandedPage.waitForFunction(`document.querySelector("h1")?.textContent === "Branded home"`);
  const own = await iconSeenBy(brandedPage);
  assert.equal(own.status, 200);
  assert.deepEqual(Buffer.from(own.bytes), ownIcon);

  await context.close();

  const drawnForBranded = (await visit(hostOf(branded), "/favicon.ico")).body;
  const origin = new URL(browserUrl(branded)).origin;
  const stranger = await browser.newContext();
  const keyless = await stranger.newPage();
  await keyless.goto(`${origin}/`);
  await keyless.waitForSelector("text=This site is private");
  assert.deepEqual(Buffer.from((await iconSeenBy(keyless)).bytes), drawnForBranded);
  const wrongKey = await stranger.newPage();
  await wrongKey.goto(`${origin}/#${randomBytes(32).toString("base64url")}`);
  await wrongKey.waitForSelector("text=This key does not open this site");
  await wrongKey.reload();
  await wrongKey.waitForSelector("text=This site is private");
  assert.deepEqual(Buffer.from((await iconSeenBy(wrongKey)).bytes), drawnForBranded);
  await stranger.close();
});
