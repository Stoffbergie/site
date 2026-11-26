import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, createGzip, gzipSync } from "node:zlib";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, inject, test } from "vite-plus/test";
import { baseUrl, browserUrl, deploy, folder, newHome, visit } from "../helpers/site";

const wasm = Buffer.from("0061736d010000000105016000017f03020100070a0106616e7377657200000a06010400412a0b", "hex");
const framework = `window.frameworkLoaded = "framework ran";${"\n/* engine */".repeat(100)}`;
const gameData = randomBytes(3000);
const backup = gzipSync(randomBytes(2000));
const csv = `day,visits\n${"monday,12\n".repeat(200)}`;
const csvGz = gzipSync(csv);
const app = `window.appRan = "app ran";${"\nfunction unused() { return 1; }".repeat(200)}`;

const loader = `
async function sha(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function load() {
  const suffix = document.documentElement.dataset.suffix;
  const result = {};
  const { instance } = await WebAssembly.instantiateStreaming(fetch("Build/game.wasm" + suffix));
  result.wasm = instance.exports.answer();
  await new Promise((done, fail) => {
    const script = document.createElement("script");
    script.src = "Build/game.framework.js" + suffix;
    script.onload = done;
    script.onerror = fail;
    document.head.append(script);
  });
  result.framework = window.frameworkLoaded;
  result.data = await sha(await (await fetch("Build/game.data" + suffix)).arrayBuffer());
  result.backup = await sha(await (await fetch("downloads/backup.tar.gz")).arrayBuffer());
  const csvResponse = await fetch("downloads/visits.csv.gz");
  result.csv = await new Response(csvResponse.body.pipeThrough(new DecompressionStream("gzip"))).text();
  result.app = window.appRan;
  return result;
}
load().then((result) => {
  window.result = result;
  document.querySelector("h1").textContent = "Loaded";
}, (error) => {
  document.querySelector("h1").textContent = "Failed: " + error;
});
`;

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function build(): string {
  const page = (suffix: string) => `<!doctype html><html data-suffix="${suffix}"><h1>Loading</h1><script src="app.js"></script><script src="loader.js"></script></html>`;
  return folder({
    "index.html": page(".gz"),
    "brotli.html": page(".br"),
    "loader.js": loader,
    "app.js": app,
    "app.js.gz": gzipSync(app),
    "app.js.br": brotliCompressSync(app),
    "Build/game.wasm.gz": gzipSync(wasm),
    "Build/game.framework.js.gz": gzipSync(framework),
    "Build/game.data.gz": gzipSync(gameData),
    "Build/game.wasm.br": brotliCompressSync(wasm),
    "Build/game.framework.js.br": brotliCompressSync(framework),
    "Build/game.data.br": brotliCompressSync(gameData),
    "Build/legacy.wasm.unityweb": brotliCompressSync(wasm),
    "Build/legacy.data.unityweb": gzipSync(gameData),
    "downloads/backup.tar.gz": backup,
    "downloads/visits.csv.gz": csvGz
  });
}

const expected = { wasm: 42, framework: "framework ran", data: sha(gameData), backup: sha(backup), csv, app: "app ran" };

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

async function loadInBrowser(link: string, path: string): Promise<unknown> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(browserUrl(link));
  await page.waitForFunction(`document.querySelector("h1")?.textContent === "Loaded" || document.querySelector("h1")?.textContent.startsWith("Failed")`);
  const origin = new URL(browserUrl(link)).origin;
  if (path !== "/") {
    await page.goto(`${origin}${path}`);
    await page.waitForFunction(`document.querySelector("h1")?.textContent === "Loaded" || document.querySelector("h1")?.textContent.startsWith("Failed")`);
  }
  const heading = await page.textContent("h1");
  assert.equal(heading, "Loaded");
  const result = await page.evaluate("window.result");
  await context.close();
  return result;
}

test("a game build with gzip and brotli files loads in a browser, and real .gz downloads arrive untouched", async () => {
  const { url, run } = await deploy(["--no-copy", build()]);
  assert.match(run.stderr, /14 files/);
  assert.deepEqual(await loadInBrowser(url, "/"), expected);
  assert.deepEqual(await loadInBrowser(url, "/brotli.html"), expected);
});

test("an encrypted game build loads the same way", async () => {
  const { url } = await deploy(["--no-copy", "-e", build()]);
  assert.deepEqual(await loadInBrowser(url, "/"), expected);
  assert.deepEqual(await loadInBrowser(url, "/brotli.html"), expected);
});

test("compressed files reach every client decoded with the inner type, and downloads stay compressed", async () => {
  const { url } = await deploy(["--no-copy", build()]);

  for (const suffix of [".gz", ".br"]) {
    for (const acceptEncoding of ["gzip, deflate, br", "br", "identity"]) {
      const headers = { "accept-encoding": acceptEncoding };
      const code = await visit(url, `/Build/game.wasm${suffix}`, { headers });
      assert.equal(code.status, 200);
      assert.equal(code.headers["content-type"], "application/wasm");
      assert.deepEqual(code.body, wasm);
      const script = await visit(url, `/Build/game.framework.js${suffix}`, { headers });
      assert.match(String(script.headers["content-type"]), /javascript/);
      assert.equal(script.text, framework);
      assert.deepEqual((await visit(url, `/Build/game.data${suffix}`, { headers })).body, gameData);
    }

    const head = await visit(url, `/Build/game.data${suffix}`, { method: "HEAD" });
    assert.equal(head.headers["content-length"], String(gameData.byteLength));
    const range = await visit(url, `/Build/game.data${suffix}`, { headers: { range: "bytes=10-19" } });
    assert.equal(range.status, 206);
    assert.deepEqual(range.body, gameData.subarray(10, 20));
  }

  const legacyCode = await visit(url, "/Build/legacy.wasm.unityweb");
  assert.equal(legacyCode.headers["content-type"], "application/wasm");
  assert.deepEqual(legacyCode.body, wasm);
  assert.deepEqual((await visit(url, "/Build/legacy.data.unityweb")).body, gameData);

  for (const [path, bytes] of [
    ["/downloads/backup.tar.gz", backup],
    ["/downloads/visits.csv.gz", csvGz]
  ] as const) {
    const download = await visit(url, path, { headers: { "accept-encoding": "gzip" } });
    assert.equal(download.headers["content-encoding"], undefined);
    assert.notEqual(download.headers["content-type"], "text/csv; charset=utf-8");
    assert.deepEqual(download.body, bytes);
  }

  assert.equal((await visit(url, "/app.js")).text, app);
  assert.equal((await visit(url, "/app.js.gz")).status, 404);
  assert.equal((await visit(url, "/app.js.br")).status, 404);
});

test("a compressed copy that differs from the file next to it is kept", async () => {
  const notes = "first version of the notes";
  const archived = gzipSync("an older version of the notes");
  const { url, run } = await deploy(["--no-copy", folder({ "index.html": "<h1>Notes</h1>", "notes.txt": notes, "notes.txt.gz": archived })]);
  assert.match(run.stderr, /3 files/);
  assert.equal((await visit(url, "/notes.txt")).text, notes);
  assert.deepEqual((await visit(url, "/notes.txt.gz")).body, archived);
});

const megabyte = 1_000_000;

function gzipOfZeros(size: number): Promise<Buffer> {
  const gzip = createGzip({ level: constants.Z_BEST_SPEED });
  const chunks: Buffer[] = [];
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
  const zeros = Buffer.alloc(megabyte);
  return new Promise((resolve, reject) => {
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    for (let written = 0; written < size; written += megabyte) gzip.write(zeros);
    gzip.end();
  });
}

function emptyFile(path: string, size: number): void {
  writeFileSync(path, "");
  truncateSync(path, size);
}

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

test("a compressed file that unpacks past the deploy limit fails the deploy without exhausting memory", async () => {
  const bomb = await gzipOfZeros(1000 * megabyte);
  const run = await runMeasured(["--no-copy", folder({ "index.html": "<h1>Game</h1>", "Build/game.data.gz": bomb })]);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /Build\/game\.data\.gz unpacks to more than the 100 MB a deploy can hold/);
  assert.ok(run.peakBytes < 300 * megabyte, `peak memory was ${run.peakBytes} bytes`);
});

test("large untouched files and large compressed copies are never read whole", async () => {
  const root = folder({ "index.html": "<h1>Downloads</h1>" });
  emptyFile(join(root, "backup.tar.gz"), 150 * megabyte);
  emptyFile(join(root, "disk.img"), 150 * megabyte);
  writeFileSync(join(root, "disk.img.gz"), await gzipOfZeros(150 * megabyte));
  const run = await runMeasured(["--no-copy", root]);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /limit is 100 MB/);
  assert.ok(run.peakBytes < 60 * megabyte, `peak memory was ${run.peakBytes} bytes`);
});

test("a compressed file with bytes after its stream, or cut short, is packed as it is", async () => {
  const wasmBrotli = brotliCompressSync(wasm);
  const wasmGzip = gzipSync(wasm);
  const files = {
    "index.html": "<h1>Game</h1>",
    "Build/trailing.wasm.br": Buffer.concat([wasmBrotli, Buffer.from("more")]),
    "Build/trailing.wasm.gz": Buffer.concat([wasmGzip, Buffer.from("more")]),
    "Build/short.wasm.gz": wasmGzip.subarray(0, wasmGzip.byteLength - 4),
    "Build/short.wasm.br": wasmBrotli.subarray(0, wasmBrotli.byteLength - 2),
    "Build/copy.wasm": wasm,
    "Build/copy.wasm.br": Buffer.concat([brotliCompressSync(wasm), Buffer.from("more")])
  };
  const { url, run } = await deploy(["--no-copy", folder(files)]);
  assert.match(run.stderr, /7 files/);
  for (const [path, bytes] of Object.entries(files)) {
    if (path === "index.html" || path === "Build/copy.wasm") continue;
    const reply = await visit(url, `/${path}`);
    assert.equal(reply.status, 200, path);
    assert.notEqual(reply.headers["content-type"], "application/wasm", path);
    assert.deepEqual(reply.body, bytes, path);
  }
});

test("a .unityweb file is kept even when it matches the file beside it", async () => {
  const { url, run } = await deploy(["--no-copy", folder({ "index.html": "<h1>Game</h1>", "Build/game.wasm": wasm, "Build/game.wasm.unityweb": brotliCompressSync(wasm) })]);
  assert.match(run.stderr, /3 files/);
  const reply = await visit(url, "/Build/game.wasm.unityweb");
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, wasm);
});

test("too many files fail before anything is unpacked, and copies left out do not count", async () => {
  const many: Record<string, string> = {};
  for (let number = 0; number < 5001; number++) many[`pages/${number}.txt`] = String(number);
  const root = folder(many);
  writeFileSync(join(root, "huge.data.gz"), await gzipOfZeros(200 * megabyte));
  const tooMany = await runMeasured(["--no-copy", root]);
  assert.notEqual(tooMany.code, 0);
  assert.match(tooMany.stderr, /that is 5002 files; a deploy holds at most 5000/);
  assert.ok(tooMany.peakBytes < 60 * megabyte, `peak memory was ${tooMany.peakBytes} bytes`);

  const exactly: Record<string, string | Buffer> = {};
  for (let number = 0; number < 5000; number++) exactly[`pages/${number}.txt`] = `page ${number}`;
  exactly["pages/0.txt.gz"] = gzipSync("page 0");
  exactly["pages/1.txt.br"] = brotliCompressSync("page 1");
  const { run } = await deploy(["--no-copy", folder(exactly)]);
  assert.match(run.stderr, /5000 files/);
  assert.match(run.stderr, /Left out 2 precompressed copies/);
});
