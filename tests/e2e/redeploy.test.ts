import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { test } from "vite-plus/test";
import { apiKeyOf, baseUrl, deploy, folder, idUrl, keyOf, newHome, runCli, upload, uniqueName, visit } from "../helpers/site";

type Counted = { url: string; sent: () => number; close: () => void };

async function countingProxy(): Promise<Counted> {
  const target = new URL(baseUrl);
  let sent = 0;
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port), target.hostname);
    client.on("data", (chunk: Buffer) => {
      sent += chunk.byteLength;
      upstream.write(chunk);
    });
    upstream.pipe(client);
    client.on("end", () => upstream.end());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, sent: () => sent, close: () => server.close() };
}

function site(): Record<string, string | Buffer> {
  return {
    "index.html": `<!doctype html><script src="/app.js"></script>${"<p>Hello there.</p>".repeat(100)}`,
    "app.js": `console.log(${JSON.stringify(randomBytes(2000).toString("hex"))});`,
    "photo.jpg": randomBytes(60_000),
    "fonts/a.woff2": randomBytes(30_000),
    "empty.txt": ""
  };
}

function compactPack(files: object[]): Buffer {
  const index = brotliCompressSync(Buffer.from(JSON.stringify({ spa: false, files })));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(index.byteLength);
  return Buffer.concat([Buffer.from("SITEPACK2\n"), length, index]);
}

async function expectServed(url: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    for (const encoding of ["gzip, deflate, br", "gzip", "br;q=0, gzip", "identity"]) {
      const reply = await visit(url, `/${path}`, { headers: { "accept-encoding": encoding } });
      assert.equal(reply.status, 200, `${path} with ${encoding}`);
      assert.ok(reply.body.equals(Buffer.from(contents)), `${path} with ${encoding} has the deployed bytes`);
    }
  }
}

test("a redeploy with one small change sends only that change and serves every file", async () => {
  const proxy = await countingProxy();
  try {
    const home = newHome();
    const files = site();
    const root = folder(files);
    const name = uniqueName("reuse");
    const first = await runCli(["--no-copy", "-n", name, root], { home, env: { SITE_URL: proxy.url } });
    assert.equal(first.code, 0, first.stderr);
    const firstSent = proxy.sent();
    assert.ok(firstSent > 90_000, `the first deploy sends the files: ${firstSent}`);

    files["index.html"] = `${files["index.html"] as string}<p>Changed.</p>`;
    writeFileSync(join(root, "index.html"), files["index.html"]);
    const second = await runCli(["--no-copy", "-n", name, root], { home, env: { SITE_URL: proxy.url } });
    assert.equal(second.code, 0, second.stderr);
    const secondSent = proxy.sent() - firstSent;
    assert.ok(secondSent < 2_000, `the redeploy sends only the change: ${secondSent}`);
    assert.match(second.stderr, /5 files/);

    await expectServed(second.stdout.trim(), files);
    const firstId = first.stderr.split(" ")[0];
    const secondId = second.stderr.split(" ")[0];
    assert.notEqual(firstId, secondId);
    await expectServed(secondId, files);
  } finally {
    proxy.close();
  }
});

test("a redeploy still works after the deploy it builds on was removed", async () => {
  const home = newHome();
  const files = site();
  const root = folder(files);
  const first = await deploy(["--no-copy", root], { home });
  const removed = await runCli(["rm", first.label], { home });
  assert.equal(removed.code, 0, removed.stderr);

  const second = await deploy(["--no-copy", root], { home });
  await expectServed(second.url, files);

  const elsewhere = newHome();
  const key = await keyOf(home);
  const copied = await runCli(["key", key], { home: elsewhere });
  assert.equal(copied.code, 0, copied.stderr);
  const third = await deploy(["--no-copy", root], { home: elsewhere });
  const before = { ...files };
  const deleted = await upload(`/deploys/${second.label}`, "", { authorization: `Bearer ${await apiKeyOf(home)}` }, "DELETE");
  assert.equal(deleted.status, 200, deleted.text);
  files["app.js"] = "console.log('changed')";
  writeFileSync(join(root, "app.js"), files["app.js"]);
  const fourth = await deploy(["--no-copy", root], { home });
  await expectServed(fourth.url, files);
  await expectServed(third.url, before);
});

test("a deploy cannot reuse files from another key's deploy", async () => {
  const owner = newHome();
  const { label } = await deploy(["--no-copy", folder({ "secret.txt": "only mine" })], { home: owner });
  const thief = await apiKeyOf(newHome());
  const body = compactPack([{ path: "copy.txt", length: 9, reuse: { id: label, file: 0 } }]);
  const refused = await upload("/", body, { authorization: `Bearer ${thief}` }, "POST");
  assert.equal(refused.status, 412, refused.text);
  const anonymous = await upload("/", body, {}, "POST");
  assert.equal(anonymous.status, 400, anonymous.text);
  assert.equal((await visit(idUrl(label), "/secret.txt")).text, "only mine");
});

test("a deploy cannot reuse files from an unowned deploy, even with a key", async () => {
  const anonymous = await upload("/notes.txt", "nobody owns these notes", {}, "PUT");
  assert.equal(anonymous.status, 201, anonymous.text);
  const label = new URL(anonymous.text.trim()).hostname.split(".")[0];
  const key = await apiKeyOf(newHome());
  const body = compactPack([{ path: "copy.txt", length: 23, reuse: { id: label, file: 0 } }]);
  const refused = await upload("/", body, { authorization: `Bearer ${key}` }, "POST");
  assert.equal(refused.status, 412, refused.text);
});

test("a private deploy never builds on a public one, and a public one never builds on a private one", async () => {
  const proxy = await countingProxy();
  try {
    const home = newHome();
    const files = site();
    const root = folder(files);
    const sentBy = async (args: string[]): Promise<{ sent: number; stdout: string; stderr: string }> => {
      const before = proxy.sent();
      const run = await runCli(["--no-copy", ...args, root], { home, env: { SITE_URL: proxy.url } });
      assert.equal(run.code, 0, run.stderr);
      return { sent: proxy.sent() - before, stdout: run.stdout, stderr: run.stderr };
    };

    const firstPrivate = await sentBy(["-e"]);
    assert.ok(firstPrivate.sent > 90_000, `a private deploy sends every file: ${firstPrivate.sent}`);
    const publicAfterPrivate = await sentBy([]);
    assert.ok(publicAfterPrivate.sent > 90_000, `a public deploy after a private one sends every file: ${publicAfterPrivate.sent}`);
    const privateAfterPublic = await sentBy(["-e"]);
    assert.ok(privateAfterPublic.sent > 90_000, `a private deploy after a public one sends every file: ${privateAfterPublic.sent}`);
    const publicAgain = await sentBy([]);
    assert.ok(publicAgain.sent < 2_000, `a public redeploy builds on the earlier public deploy: ${publicAgain.sent}`);
    await expectServed(publicAgain.stdout.trim(), files);

    const privateLabel = new URL(privateAfterPublic.stdout.trim()).hostname.split(".")[0];
    const body = compactPack([{ path: "index.html", length: 64, reuse: { id: privateLabel, file: 0 } }]);
    const refused = await upload("/", body, { authorization: `Bearer ${await apiKeyOf(home)}` }, "POST");
    assert.equal(refused.status, 412, refused.text);
  } finally {
    proxy.close();
  }
});
