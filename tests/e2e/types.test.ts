import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { baseUrl, browserUrl, deploy, folder, visit } from "../helpers/site";

const binary = Buffer.concat([Buffer.from([0, 1, 2, 3, 0xff, 0xfe]), randomBytes(2000)]);
const utf8 = "text/plain; charset=utf-8";

const expected: Record<string, string> = {
  "feed.rss": "application/rss+xml; charset=utf-8",
  "feed.atom": "application/atom+xml; charset=utf-8",
  "atom.xml": "application/xml; charset=utf-8",
  "feed.json": "application/json; charset=utf-8",
  "sitemap.xml": "application/xml; charset=utf-8",
  "robots.txt": utf8,
  "site.webmanifest": "application/manifest+json; charset=utf-8",
  "app.js.map": "application/json; charset=utf-8",
  "app.mjs": "text/javascript; charset=utf-8",
  "lib.cjs": "text/javascript; charset=utf-8",
  "data.jsonld": "application/ld+json; charset=utf-8",
  "places.geojson": "application/geo+json; charset=utf-8",
  "page.xhtml": "application/xhtml+xml; charset=utf-8",
  "photo.avif": "image/avif",
  "photo.jxl": "image/jxl",
  "spinner.apng": "image/apng",
  "photo.heic": "image/heic",
  "photo.heif": "image/heif",
  "photo.bmp": "image/bmp",
  "scan.tiff": "image/tiff",
  "favicon.ico": "image/x-icon",
  "pointer.cur": "image/x-icon",
  "family.ttc": "font/collection",
  "legacy.eot": "application/vnd.ms-fontobject",
  "font.woff2": "font/woff2",
  "clip.mp4": "video/mp4",
  "clip.webm": "video/webm",
  "clip.mov": "video/quicktime",
  "clip.ogv": "video/ogg",
  "clip.mkv": "video/matroska",
  "song.m4a": "audio/mp4",
  "song.aac": "audio/aac",
  "song.flac": "audio/flac",
  "song.opus": "audio/ogg",
  "song.weba": "audio/webm",
  "song.mid": "audio/midi",
  "stream.m3u8": "application/vnd.apple.mpegurl",
  "segment.ts": "video/mp2t",
  "segment.m4s": "video/iso.segment",
  "stream.mpd": "application/dash+xml; charset=utf-8",
  "captions.vtt": "text/vtt; charset=utf-8",
  "captions.srt": "application/x-subrip",
  "model.glb": "model/gltf-binary",
  "scene.gltf": "model/gltf+json",
  "scene.usdz": "model/vnd.usdz+zip",
  "mesh.obj": "model/obj",
  "mesh.stl": "model/stl",
  "texture.ktx2": "image/ktx2",
  "game.wasm": "application/wasm",
  "game.data": "application/octet-stream",
  "book.epub": "application/epub+zip",
  "paper.pdf": "application/pdf",
  "report.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "sheet.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "slides.pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "notes.md": "text/markdown; charset=utf-8",
  "config.yaml": "text/yaml; charset=utf-8",
  "config.yml": "text/yaml; charset=utf-8",
  "config.toml": "application/toml",
  "table.csv": "text/csv; charset=utf-8",
  "table.tsv": "text/tab-separated-values; charset=utf-8",
  "bundle.zip": "application/zip",
  "bundle.tar": "application/x-tar",
  "bundle.7z": "application/x-7z-compressed",
  "event.ics": "text/calendar; charset=utf-8",
  "contact.vcf": "text/vcard; charset=utf-8",
  "shader.wgsl": "text/wgsl; charset=utf-8",
  "shader.glsl": utf8,
  LICENSE: utf8,
  CNAME: utf8,
  README: utf8,
  AUTHORS: utf8,
  "apple-app-site-association": "application/json; charset=utf-8",
  "level.pak": "application/octet-stream",
  blob: "application/octet-stream"
};

const contents: Record<string, string | Buffer> = {
  "shader.glsl": "void main() { gl_FragColor = vec4(1.0); }\n",
  LICENSE: "MIT License\n\nCopyright (c) 2026\n",
  CNAME: "www.example.com\n",
  README: "Read me first.\n",
  AUTHORS: "Zoë Ångström 🎉\n",
  "apple-app-site-association": '{"applinks":{"details":[]}}',
  "level.pak": binary,
  blob: binary
};

function filesFor(names: string[]): Record<string, string | Buffer> {
  const files: Record<string, string | Buffer> = { "index.html": "<h1>Types</h1>" };
  for (const name of names) {
    const given = contents[name];
    if (given !== undefined) files[name] = given;
    else if (expected[name].endsWith("; charset=utf-8")) files[name] = "Text in UTF-8: Zoë ✓\n";
    else files[name] = binary;
  }
  return files;
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

async function newPage(): Promise<Page> {
  const context = await browser.newContext({ acceptDownloads: true });
  return context.newPage();
}

test("every kind of file a site ships is served with the type browsers expect", async () => {
  const { url } = await deploy(["--no-copy", folder(filesFor(Object.keys(expected)))]);
  const served: Record<string, string | undefined> = {};
  for (const name of Object.keys(expected)) served[name] = (await visit(url, `/${name}`)).headers["content-type"];
  assert.deepEqual(served, expected);
});

test("an encrypted site serves every kind of file with the same types", async () => {
  const { url } = await deploy(["--no-copy", "-e", folder(filesFor(Object.keys(expected)))]);
  const page = await newPage();
  await page.goto(browserUrl(url));
  await page.waitForFunction(`document.querySelector("h1")?.textContent === "Types"`);
  const served = await page.evaluate(async (names: string[]) => {
    const types: Record<string, string | null> = {};
    for (const name of names) types[name] = (await fetch(`/${name}`)).headers.get("content-type");
    return types;
  }, Object.keys(expected));
  assert.deepEqual(served, expected);
  await page.context().close();
});

test.each([
  ["feed.rss", "<rss version='2.0'><channel><title>Feed</title></channel></rss>", "application/rss+xml; charset=utf-8"],
  ["model.glb", binary, "model/gltf-binary"],
  ["captions.vtt", "WEBVTT\n", "text/vtt; charset=utf-8"],
  ["LICENSE", "MIT License\n", utf8],
  ["blob", binary, "application/octet-stream"]
])("curl -T %s gets the type browsers expect", async (name, body, type) => {
  const root = folder({ [name]: body });
  const url = execFileSync("curl", ["-fsS", "-T", join(root, name), baseUrl], { encoding: "utf8" }).trim();
  const served = await visit(url, `/${name}`);
  assert.equal(served.headers["content-type"], type);
  assert.deepEqual(served.body, Buffer.from(body));
});

test("scripts, JSON modules and captions work, and feeds and plain text open in the browser", async () => {
  const feed = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Site feed</title><item><title>Hello</title></item></channel></rss>`;
  const { url } = await deploy([
    "--no-copy",
    folder({
      "index.html": `<!doctype html><h1>Home</h1><script src="/lib.cjs"></script><script type="module" src="/app.mjs"></script><video><track kind="captions" src="/captions.vtt" default></video>`,
      "lib.cjs": "document.documentElement.dataset.classic = 'ran'",
      "app.mjs": `import places from "/places.geojson" with { type: "json" };\ndocument.documentElement.dataset.places = String(places.features.length);`,
      "places.geojson": `{"type":"FeatureCollection","features":[{"type":"Feature","geometry":null,"properties":{}}]}`,
      "captions.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nHello there\n",
      "feed.rss": feed,
      LICENSE: "MIT License\n\nPermission is hereby granted.\n",
      "event.ics": "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n",
      "level.pak": binary
    })
  ]);
  const origin = new URL(browserUrl(url)).origin;
  const page = await newPage();

  await page.goto(`${origin}/`);
  await page.waitForFunction(`document.documentElement.dataset.classic === "ran"`);
  await page.waitForFunction(`document.documentElement.dataset.places === "1"`);
  await page.waitForFunction(`document.querySelector("track").readyState === 2`);
  assert.equal(await page.evaluate(`document.querySelector("track").track.cues[0].text`), "Hello there");

  const feedPage = await page.goto(`${origin}/feed.rss`);
  assert.equal(feedPage?.status(), 200);
  assert.match((await page.textContent("body")) ?? "", /Site feed/);

  await page.goto(`${origin}/LICENSE`);
  assert.equal(await page.textContent("body"), "MIT License\n\nPermission is hereby granted.\n");

  for (const download of ["event.ics", "level.pak"]) {
    const started = page.waitForEvent("download");
    await page.goto(`${origin}/${download}`).catch(() => null);
    assert.equal((await started).suggestedFilename(), download);
  }
  await page.context().close();
});
