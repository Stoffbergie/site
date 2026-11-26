import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, inject, test } from "vite-plus/test";
import { baseUrl, browserUrl, deploy, folder, newHome, uniqueName, visit } from "../helpers/site";

function ascii(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

function windows1252(text: string): Buffer {
  return Buffer.from(Array.from(text, (character) => (character === "€" ? 0x80 : character.charCodeAt(0))));
}

function hex(bytes: string): Buffer {
  return Buffer.from(bytes, "hex");
}

function utf16be(text: string): Buffer {
  return Buffer.from(text, "utf16le").swap16();
}

function htmlPage(head: string, body: Buffer): Buffer {
  return Buffer.concat([ascii(`<!doctype html><html><head>${head}<title>Page</title></head><body><p>`), body, ascii("</p></body></html>")]);
}

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const utf16Bom = Buffer.from([0xff, 0xfe]);
const japanese = hex("93fa967b8cea");
const chinese = hex("d6d0cec4");
const korean = hex("c7d1b1b9beee");

type Case = { path: string; bytes: Buffer; sees: string; matchesDisk?: boolean };

const cases: Case[] = [
  {
    path: "windows-1252.html",
    bytes: htmlPage(`<meta charset="windows-1252"><script defer src="legacy.js"></script><link rel="stylesheet" href="inherit.css">`, windows1252("Café naïve €")),
    sees: 'Café naïve €\né€ from a script\n"ñ"'
  },
  { path: "word-export.htm", bytes: htmlPage(`<meta http-equiv=Content-Type content="text/html; charset=iso-8859-1">`, windows1252("Größe Ünïcödé")), sees: "Größe Ünïcödé" },
  { path: "shift-jis.html", bytes: htmlPage(`<meta charset="Shift_JIS">`, japanese), sees: "日本語" },
  { path: "gb18030.html", bytes: htmlPage(`<META CHARSET=gb18030>`, chinese), sees: "中文" },
  { path: "euc-kr.html", bytes: htmlPage(`<meta http-equiv="content-type" content="text/html;charset=euc-kr">`, korean), sees: "한국어" },
  { path: "ascii-shell.html", bytes: htmlPage(`<meta charset="shift_jis"><script defer src="shift-jis.js"></script>`, ascii("Loading")), sees: "Loading\n日本語" },
  { path: "utf-16.html", bytes: Buffer.concat([utf16Bom, Buffer.from(`<!doctype html><title>Page</title><p>Grüße 日本語</p>`, "utf16le")]), sees: "Grüße 日本語" },
  { path: "utf-8-bom.html", bytes: Buffer.concat([utf8Bom, Buffer.from(`<!doctype html><title>Page</title><p>Grüße 日本語</p>`)]), sees: "Grüße 日本語" },
  {
    path: "utf-8-bare.html",
    bytes: Buffer.from(`<!doctype html><title>Page</title><p>Grüße 日本語 ✓</p><script src="utf-8.js"></script><link rel="stylesheet" href="utf-8.css">`),
    sees: 'Grüße 日本語 ✓\n✓ from a script\n"✓"',
    matchesDisk: false
  },
  { path: "utf-8-declared.html", bytes: Buffer.from(`<!doctype html><meta charset="utf-8"><title>Page</title><p>Grüße <!-- <meta charset="windows-1252"> --> 日本語</p>`), sees: "Grüße 日本語" },
  { path: "utf-8-css.html", bytes: Buffer.from(`<!doctype html><meta charset="utf-8"><title>Page</title><link rel="stylesheet" href="latin-1.css"><p>Styled</p>`), sees: 'Styled\n"é"' },
  { path: "latin-1-undeclared.html", bytes: htmlPage("", windows1252("Ça va très bien")), sees: "Ça va très bien" },
  { path: "latin-1.txt", bytes: windows1252("Crème brûlée"), sees: "Crème brûlée" },
  { path: "utf-8.txt", bytes: Buffer.from("Crème brûlée ✓"), sees: "Crème brûlée ✓", matchesDisk: false },
  { path: "latin-1.xml", bytes: Buffer.concat([ascii(`<?xml version="1.0" encoding="ISO-8859-1"?><note>`), windows1252("Smörgåsbord"), ascii("</note>")]), sees: "Smörgåsbord" },
  {
    path: "latin-1.svg",
    bytes: Buffer.concat([ascii(`<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg"><text y="20">`), windows1252("Café"), ascii("</text></svg>")]),
    sees: "Café"
  },
  { path: "unknown-label.html", bytes: Buffer.from(`<!doctype html><meta charset="unknown"><title>Page</title><p>Café ✓</p>`), sees: "Café ✓", matchesDisk: false },
  {
    path: "empty-label.html",
    bytes: Buffer.from(`<!doctype html><meta http-equiv="Content-Type" content="text/html; charset="><meta charset=""><title>Page</title><p>Café ✓</p>`),
    sees: "Café ✓",
    matchesDisk: false
  },
  { path: "unknown-then-legacy.html", bytes: Buffer.from(`<!doctype html><meta charset="bogus"><meta charset="windows-1252"><title>Page</title><p>Café</p>`), sees: "CafÃ©" },
  { path: "utf-16le-no-bom.html", bytes: Buffer.from(`<?xml version="1.0"?><!doctype html><title>Page</title><p>Hello</p>`, "utf16le"), sees: "Hello" },
  { path: "utf-16be-no-bom.xml", bytes: utf16be(`<?xml version="1.0" encoding="UTF-16"?><note>Hello</note>`), sees: "Hello" },
  { path: "xml-declared.html", bytes: Buffer.from(`<?xml version="1.0" encoding="windows-1252"?><!doctype html><title>Page</title><p>Café</p>`), sees: "CafÃ©" },
  { path: "script-string.html", bytes: Buffer.from(`<!doctype html><title>Page</title><script>const tag = "<meta charset=shift_jis>";</script><p>Café ✓</p>`), sees: "Café ✓", matchesDisk: false },
  {
    path: "title-string.html",
    bytes: Buffer.from(`<!doctype html><title>Page <meta charset=shift_jis></title><style>/* <meta charset=gbk> */</style><p>Café ✓</p>`),
    sees: "Café ✓",
    matchesDisk: false
  },
  {
    path: "spaced-charset.html",
    bytes: htmlPage(`<meta charset="windows-1252"><link rel="stylesheet" href="spaced-charset.css">`, ascii("Styled")),
    sees: 'Styled\n"✓"',
    matchesDisk: false
  }
];

const supporting: Record<string, Buffer> = {
  "index.html": Buffer.from("<h1>Encodings</h1>"),
  "legacy.js": Buffer.concat([ascii(`document.body.append(Object.assign(document.createElement("p"), { textContent: "`), windows1252("é€"), ascii(` from a script" }));`)]),
  "inherit.css": Buffer.concat([ascii(`p:first-of-type::after { content: "`), windows1252("ñ"), ascii(`" }`)]),
  "shift-jis.js": Buffer.concat([ascii(`document.body.append(Object.assign(document.createElement("p"), { textContent: "`), japanese, ascii(`" }));`)]),
  "utf-8.js": Buffer.from(`document.body.append(Object.assign(document.createElement("p"), { textContent: "✓ from a script" }));`),
  "utf-8.css": Buffer.from(`p:first-of-type::after { content: "✓" }`),
  "spaced-charset.css": Buffer.from(`@charset "iso-8859-1" ;\np:first-of-type::after { content: "✓"; }`),
  "latin-1.css": Buffer.concat([ascii(`@charset "iso-8859-1";\np:first-of-type::after { content: "`), windows1252("é"), ascii(`" }`)])
};

const seenText = `(() => {
  const root = document.documentElement;
  const xmlSource = document.getElementById("webkit-xml-viewer-source-xml");
  let shown = root.textContent;
  if (xmlSource !== null) shown = xmlSource.textContent;
  else if (root instanceof HTMLElement) shown = root.innerText;
  const parts = [shown];
  for (const element of document.querySelectorAll("*")) {
    const after = getComputedStyle(element, "::after").content;
    if (after !== "none" && after !== "normal") parts.push(after);
  }
  return parts.join("\\n").split("\\n").map((line) => line.trim()).filter((line) => line !== "").join("\\n");
})()`;

let browser: Browser;
let root: string;
const fromDisk = new Map<string, string>();

beforeAll(async () => {
  browser = await chromium.launch();
  const files: Record<string, Buffer> = { ...supporting };
  for (const item of cases) files[item.path] = item.bytes;
  root = folder(files);
  const page = await browser.newPage();
  for (const item of cases) fromDisk.set(item.path, await see(page, pathToFileURL(join(root, item.path)).href));
  await page.context().close();
});

afterAll(async () => {
  await browser.close();
});

async function see(page: Page, url: string): Promise<string> {
  await page.goto(url);
  await page.waitForFunction(`document.readyState === "complete" && document.querySelector("[data-state]") === null`);
  return page.evaluate(seenText);
}

async function checkEverySite(origin: string, page: Page): Promise<void> {
  for (const item of cases) {
    const seen = await see(page, `${origin}/${item.path}`);
    assert.equal(seen, item.sees, `${item.path} on ${origin}`);
    if (item.matchesDisk !== false) assert.equal(seen, fromDisk.get(item.path), `${item.path} on ${origin} matches the file opened from disk`);
  }
}

test("pages in any encoding read the same as from disk on id and named hosts", async () => {
  const home = newHome();
  const byId = await deploy(["--no-copy", root], { home });
  const byName = await deploy(["--no-copy", "-n", uniqueName("charset"), root], { home });
  const page = await browser.newPage();
  await checkEverySite(new URL(browserUrl(byId.url)).origin, page);
  await checkEverySite(new URL(browserUrl(byName.url)).origin, page);
  await page.context().close();
});

test("pages in any encoding read the same as from disk on encrypted sites", async () => {
  const home = newHome();
  for (const args of [["-e"], ["-e", "-n", uniqueName("secret")]]) {
    const { url } = await deploy(["--no-copy", ...args, root], { home });
    const page = await browser.newPage();
    await page.goto(browserUrl(url));
    await page.waitForFunction(`document.querySelector("h1")?.textContent === "Encodings" && navigator.serviceWorker.controller !== null`);
    await checkEverySite(new URL(browserUrl(url)).origin, page);
    await page.context().close();
  }
});

test("utf-8 text keeps its charset and other encodings let the file declare its own", async () => {
  const { url } = await deploy(["--no-copy", root]);
  const typeOf = async (path: string) => (await visit(url, `/${path}`)).headers["content-type"];
  assert.equal(await typeOf("utf-8-bare.html"), "text/html; charset=utf-8");
  assert.equal(await typeOf("utf-8-bom.html"), "text/html; charset=utf-8");
  assert.equal(await typeOf("utf-8.js"), "text/javascript; charset=utf-8");
  assert.equal(await typeOf("utf-8.txt"), "text/plain; charset=utf-8");
  assert.equal(await typeOf("windows-1252.html"), "text/html");
  assert.equal(await typeOf("ascii-shell.html"), "text/html");
  assert.equal(await typeOf("legacy.js"), "text/javascript");
  assert.equal(await typeOf("latin-1.css"), "text/css");
  assert.equal(await typeOf("latin-1.xml"), "application/xml");
  assert.equal(await typeOf("unknown-label.html"), "text/html; charset=utf-8");
  assert.equal(await typeOf("empty-label.html"), "text/html; charset=utf-8");
  assert.equal(await typeOf("unknown-then-legacy.html"), "text/html");
  assert.equal(await typeOf("utf-16le-no-bom.html"), "text/html");
  assert.equal(await typeOf("utf-16be-no-bom.xml"), "application/xml");
  assert.equal(await typeOf("xml-declared.html"), "text/html");
  assert.equal(await typeOf("script-string.html"), "text/html; charset=utf-8");
  assert.equal(await typeOf("title-string.html"), "text/html; charset=utf-8");
  assert.equal(await typeOf("spaced-charset.css"), "text/css; charset=utf-8");
});

test("a single file sent with curl gets the type it gets in a folder and reads the same as from disk", async () => {
  const { url: folderUrl } = await deploy(["--no-copy", root]);
  const page = await browser.newPage();
  for (const path of [...cases.map((item) => item.path), ...Object.keys(supporting)]) {
    const url = execFileSync("curl", ["-fsS", "-T", join(root, path), baseUrl], { encoding: "utf8" }).trim();
    const single = await visit(url, `/${path}`);
    const packed = await visit(folderUrl, `/${path}`);
    assert.equal(single.headers["content-type"], packed.headers["content-type"], `${path} sent with curl has the type it has in a folder`);
    const item = cases.find((candidate) => candidate.path === path);
    if (item === undefined) continue;
    const seen = await see(page, `${new URL(browserUrl(url)).origin}/${path}`);
    assert.equal(seen.split("\n")[0], item.sees.split("\n")[0], `${path} sent with curl`);
  }
  await page.context().close();
});

const legacyNfo = windows1252("Café ¦ Größe");
const legacyLicense = windows1252("Copyright © Zoë Müller");
const legacyChallenge = windows1252("token-café");
const legacyPage = htmlPage(`<meta charset="windows-1252">`, windows1252("Café naïve €"));
const utf8Page = Buffer.from(`<!doctype html><title>Page</title><p>Grüße 日本語 ✓</p>`);

test("legacy text is sent without a charset for table-only, extensionless, .well-known and precompressed files", async () => {
  const files = folder({
    "index.html": Buffer.from("<h1>More encodings</h1>"),
    "readme.nfo": legacyNfo,
    LICENSE: legacyLicense,
    ".well-known/acme-challenge/legacy": legacyChallenge,
    "legacy.html.gz": gzipSync(legacyPage),
    "utf-8.html.gz": gzipSync(utf8Page)
  });
  const { url } = await deploy(["--no-copy", files]);
  const expected: [string, string, Buffer][] = [
    ["/readme.nfo", "text/x-nfo", legacyNfo],
    ["/LICENSE", "text/plain", legacyLicense],
    ["/.well-known/acme-challenge/legacy", "text/plain", legacyChallenge],
    ["/legacy.html.gz", "text/html", legacyPage],
    ["/utf-8.html.gz", "text/html; charset=utf-8", utf8Page]
  ];
  for (const [path, type, bytes] of expected) {
    const reply = await visit(url, path);
    assert.equal(reply.headers["content-type"], type, `${path} has its type`);
    assert.deepEqual(reply.body, bytes, `${path} arrives as the file`);
  }
  const page = await browser.newPage();
  const origin = new URL(browserUrl(url)).origin;
  assert.equal(await see(page, `${origin}/legacy.html.gz`), "Café naïve €");
  assert.equal(await see(page, `${origin}/utf-8.html.gz`), "Grüße 日本語 ✓");
  await page.context().close();

  for (const [name, type] of [
    ["readme.nfo", "text/x-nfo"],
    ["LICENSE", "text/plain"]
  ]) {
    const single = execFileSync("curl", ["-fsS", "-T", join(files, name), baseUrl], { encoding: "utf8" }).trim();
    const reply = await visit(single, `/${name}`);
    assert.equal(reply.headers["content-type"], type, `${name} sent with curl has its type`);
  }
});

const megabyte = 1024 * 1024;

type MeasuredRun = { code: number | null; stdout: string; stderr: string; peakBytes: number };

function runMeasured(args: string[]): Promise<MeasuredRun> {
  const home = newHome();
  const env: Record<string, string> = { ...(process.env as Record<string, string>), SITE_URL: baseUrl, HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1" };
  delete env.SITE_KEY;
  const timeFlag = process.platform === "darwin" ? "-l" : "-v";
  const child = spawn("/usr/bin/time", [timeFlag, inject("cli"), ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end();
  return new Promise((resolve) =>
    child.on("close", (code) => {
      const bytesOnMac = /(\d+)\s+maximum resident set size/.exec(stderr);
      const kilobytesOnLinux = /Maximum resident set size \(kbytes\): (\d+)/.exec(stderr);
      let peakBytes = Number.NaN;
      if (bytesOnMac) peakBytes = Number(bytesOnMac[1]);
      if (kilobytesOnLinux) peakBytes = Number(kilobytesOnLinux[1]) * 1024;
      resolve({ code, stdout, stderr, peakBytes });
    })
  );
}

function textAcrossChunks(): Buffer {
  const chunk = 64 * 1024;
  return Buffer.concat([
    Buffer.from("Notes ".padEnd(chunk - 1, "a")),
    Buffer.from("€"),
    Buffer.from("b".repeat(chunk - 4)),
    Buffer.from("😀"),
    Buffer.from("c".repeat(chunk * 2 - 2)),
    Buffer.from("ë\n")
  ]);
}

test("large extensionless files are judged without being read whole and keep the right charset", async () => {
  const header = Buffer.from("FIRMWARE IMAGE v1 ".repeat(40).slice(0, 512));
  const notes = textAcrossChunks();
  const root = folder({ "index.html": "<h1>Downloads</h1>", notes });
  const firmware = openSync(join(root, "firmware"), "w");
  writeSync(firmware, header);
  const binary = Buffer.alloc(megabyte, 0xff);
  for (let written = 0; written < 80; written++) writeSync(firmware, binary);
  closeSync(firmware);

  const run = await runMeasured(["--no-copy", root]);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.peakBytes < 40 * megabyte, `peak memory was ${run.peakBytes} bytes`);
  const url = run.stdout.trim();

  const start = await visit(url, "/firmware", { headers: { range: "bytes=0-1023" } });
  assert.equal(start.headers["content-type"], "text/plain");
  assert.deepEqual(start.body, Buffer.concat([header, binary.subarray(0, 512)]));
  const text = await visit(url, "/notes");
  assert.equal(text.headers["content-type"], "text/plain; charset=utf-8");
  assert.deepEqual(text.body, notes);
});
