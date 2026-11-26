import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { brotliCompressSync, constants, createBrotliCompress } from "node:zlib";
import { test } from "vite-plus/test";
import { apiKeyOf, baseUrl, newHome, upload, visit, type Reply } from "../helpers/site";

function pack(index: unknown, data: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(index));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.byteLength);
  return Buffer.concat([Buffer.from("SITEPACK1\n"), length, json, data]);
}

async function ownedFile(key: string, name: string, bytes: Buffer): Promise<string> {
  const deployed = await upload(`/${name}`, bytes, { authorization: `Bearer ${key}` }, "PUT");
  assert.equal(deployed.status, 201, deployed.text);
  return new URL(deployed.text.trim()).hostname.split(".")[0];
}

function uploadInParts(parts: Buffer[], between: () => Promise<void>, headers: Record<string, string>): Promise<Reply> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  return new Promise((resolve, reject) => {
    const port = new URL(baseUrl).port;
    const request = httpRequest({ host: "127.0.0.1", port, path: "/", method: "POST", headers: { "content-length": String(total), ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body, text: body.toString("utf8") });
      });
    });
    request.on("error", reject);
    request.write(parts[0]);
    void between().then(() => {
      for (const part of parts.slice(1)) request.write(part);
      request.end();
    });
  });
}

function compactUpload(compressedIndex: Buffer, data: Buffer = Buffer.alloc(0)): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(compressedIndex.byteLength);
  return Buffer.concat([Buffer.from("SITEPACK2\n"), length, compressedIndex, data]);
}

function compactIndex(files: object[]): Buffer {
  return brotliCompressSync(Buffer.from(JSON.stringify({ spa: false, files })));
}

async function brotliOfSpaces(gibibytes: number): Promise<Buffer> {
  const encoder = createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_LGWIN]: 24 } });
  const parts: Buffer[] = [];
  encoder.on("data", (part: Buffer) => parts.push(part));
  const finished = new Promise((resolve) => encoder.on("end", resolve));
  const chunk = Buffer.alloc(16 * 1024 * 1024, 0x20);
  for (let written = 0; written < gibibytes * 64; written += 1) encoder.write(chunk);
  encoder.end();
  await finished;
  return Buffer.concat(parts);
}

test("an index that expands enormously is refused quickly, whatever it expands to", { timeout: 60_000 }, async () => {
  const bomb = await brotliOfSpaces(4);
  assert.ok(bomb.byteLength < 10_000, `the upload is small: ${bomb.byteLength}`);
  const started = performance.now();
  const refused = await upload("/", compactUpload(bomb), {}, "POST");
  const seconds = (performance.now() - started) / 1000;
  assert.equal(refused.status, 400, refused.text);
  assert.match(refused.text, /too large/);
  assert.ok(seconds < 1, `refused in ${seconds}s`);
  const fine = await upload("/", compactUpload(compactIndex([{ path: "index.html", length: 2 }]), Buffer.from("hi")), {}, "POST");
  assert.equal(fine.status, 201, fine.text);
});

test("a reuse whose earlier deploy disappears mid-upload answers 412, so the CLI sends everything instead", { timeout: 60_000 }, async () => {
  const key = await apiKeyOf(newHome());
  const source = await ownedFile(key, "shared.txt", randomBytes(5000));
  const files: object[] = [];
  const bodies: Buffer[] = [];
  for (let run = 0; run < 10; run += 1) {
    const body = randomBytes(512 * 1024);
    bodies.push(body);
    files.push({ path: `body-${run}.bin`, length: body.byteLength });
    files.push({ path: `copy-${run}.txt`, length: 5000, type: "text/plain; charset=utf-8", reuse: { id: source, file: 0 } });
  }
  const header = compactUpload(compactIndex(files));
  const removeSource = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const deleted = await upload(`/deploys/${source}`, "", { authorization: `Bearer ${key}` }, "DELETE");
    assert.equal(deleted.status, 200, deleted.text);
  };
  const reply = await uploadInParts([Buffer.concat([header, bodies[0]]), ...bodies.slice(1)], removeSource, { authorization: `Bearer ${key}` });
  assert.equal(reply.status, 412, reply.text);
});

test("an upload cannot store an index or a deploy larger than the limits by reusing files", { timeout: 120_000 }, async () => {
  const key = await apiKeyOf(newHome());
  const longPaths = Array.from({ length: 5000 }, (_, number) => ({ path: `${"deep/".repeat(68)}${number}.txt`, length: 0 }));
  const hugeIndex = await upload("/", compactUpload(compactIndex(longPaths)), { authorization: `Bearer ${key}` }, "POST");
  assert.equal(hugeIndex.status, 400, hugeIndex.text);
  assert.match(hugeIndex.text, /index is too large/);

  const source = await ownedFile(key, "big.bin", randomBytes(2_000_000));
  const copies = Array.from({ length: 51 }, (_, number) => ({ path: `copy-${number}.bin`, length: 2_000_000, reuse: { id: source, file: 0 } }));
  const tooBig = await upload("/", compactUpload(compactIndex(copies)), { authorization: `Bearer ${key}` }, "POST");
  assert.equal(tooBig.status, 413, tooBig.text);
});

test("a raw pack cannot mark its files as brotli; only the Worker writes that", async () => {
  const index = { spa: false, files: [{ path: "index.html", offset: 0, length: 5, type: "text/html; charset=utf-8", gzip: false, br: true }] };
  const refused = await upload("/", pack(index, Buffer.from("hello")), {}, "POST");
  assert.equal(refused.status, 400, refused.text);
  assert.match(refused.text, /br/);
});

test("the brotli and the plain representation of a file have different ETags", async () => {
  const html = `<!doctype html>${"<p>Hello there, this compresses well.</p>".repeat(50)}`;
  const deployed = await upload("/", compactUpload(compactIndex([{ path: "index.html", length: 0 }])), {}, "POST");
  assert.equal(deployed.status, 201, deployed.text);
  const compressed = brotliCompressSync(Buffer.from(html));
  const site = await upload("/", compactUpload(compactIndex([{ path: "index.html", length: compressed.byteLength, encoding: "br" }]), compressed), {}, "POST");
  assert.equal(site.status, 201, site.text);
  const url = site.text.trim();
  const brotli = await visit(url, "/", { headers: { "accept-encoding": "br" } });
  const plain = await visit(url, "/", { headers: { "accept-encoding": "identity" } });
  assert.equal(plain.text, html);
  assert.ok(brotli.headers.etag && plain.headers.etag);
  assert.notEqual(brotli.headers.etag, plain.headers.etag);
  const crossed = await visit(url, "/", { headers: { "accept-encoding": "identity", "if-none-match": brotli.headers.etag } });
  assert.equal(crossed.status, 200);
  assert.equal(crossed.text, html);
  const same = await visit(url, "/", { headers: { "accept-encoding": "identity", "if-none-match": plain.headers.etag } });
  assert.equal(same.status, 304);
  const sameBrotli = await visit(url, "/", { headers: { "accept-encoding": "gzip, br", "if-none-match": `W/${brotli.headers.etag}` } });
  assert.equal(sameBrotli.status, 304);
});

test("a compact upload's rules pass the same checks as a raw pack's and are stored for every reader", async () => {
  const files = [{ path: "index.html", length: 2 }];
  const malformed = { spa: false, files, rules: { redirects: [{ from: "old", to: "/new", status: 301, force: false }] } };
  const refused = await upload("/", compactUpload(brotliCompressSync(Buffer.from(JSON.stringify(malformed))), Buffer.from("hi")), {}, "POST");
  assert.equal(refused.status, 400, refused.text);
  assert.match(refused.text, /rule/i);

  const twoSplats = { spa: false, files, rules: { headers: [{ path: "/*/*", headers: [{ name: "X-A", value: "1" }] }] } };
  const splats = await upload("/", compactUpload(brotliCompressSync(Buffer.from(JSON.stringify(twoSplats))), Buffer.from("hi")), {}, "POST");
  assert.equal(splats.status, 400, splats.text);

  const rules = { redirects: [{ from: "/old", to: "/new", status: 301, force: false, later: true }], headers: [{ path: "/*", headers: [{ name: "X-Rule", value: "kept" }] }], later: 1 };
  const accepted = await upload("/", compactUpload(brotliCompressSync(Buffer.from(JSON.stringify({ spa: false, files, rules }))), Buffer.from("hi")), {}, "POST");
  assert.equal(accepted.status, 201, accepted.text);
  const url = accepted.text.trim();
  const moved = await visit(url, "/old");
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.location, "/new");
  const home = await visit(url, "/");
  assert.equal(home.text, "hi");
  assert.equal(home.headers["x-rule"], "kept");

  const raw = await upload("/", pack({ spa: false, files: [{ path: "index.html", offset: 0, length: 2, type: "text/html; charset=utf-8", gzip: false }], rules }, Buffer.from("hi")), {}, "POST");
  assert.equal(raw.status, 201, raw.text);
  const rawUrl = raw.text.trim();
  assert.equal((await visit(rawUrl, "/old")).headers.location, "/new");
  assert.equal((await visit(rawUrl, "/")).headers["x-rule"], "kept");
});

test("rules count toward the compact index limits", async () => {
  const redirects = Array.from({ length: 9_000 }, (_, number) => ({ from: `/page-${number}`, to: `/${"d".repeat(1_900)}`, status: 301, force: false }));
  const index = brotliCompressSync(Buffer.from(JSON.stringify({ spa: false, files: [{ path: "index.html", length: 2 }], rules: { redirects } })));
  assert.ok(index.byteLength < 262_144, `${index.byteLength} compressed bytes`);
  const refused = await upload("/", compactUpload(index, Buffer.from("hi")), {}, "POST");
  assert.equal(refused.status, 400, refused.text);
  assert.match(refused.text, /too large/);
});
