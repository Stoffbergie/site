import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
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

test("small files served from memory, neighbouring reads and revalidations carry cross-origin headers and carried ETags", async () => {
  const home = newHome();
  const files: Record<string, string | Buffer> = { "index.html": "<h1>One</h1>", "a.css": "a{color:red}", "b.js": "console.log(1)", "photo.jpg": randomBytes(50_000) };
  const root = folder(files);
  const name = uniqueName("cached");
  const first = await runCli(["--no-copy", "-n", name, root], { home });
  assert.equal(first.code, 0, first.stderr);
  const site = first.stdout.trim();
  const origin = "https://elsewhere.example";
  const crossOrigin = (reply: Awaited<ReturnType<typeof visit>>, label: string): void => {
    assert.equal(reply.headers["access-control-allow-origin"], origin, label);
    assert.equal(reply.headers["access-control-allow-credentials"], "true", label);
    assert.equal(reply.headers["cross-origin-resource-policy"], "cross-origin", label);
    assert.equal(reply.headers["timing-allow-origin"], "*", label);
  };

  const neighbourRead = await visit(site, "/b.js", { headers: { origin } });
  assert.equal(neighbourRead.text, files["b.js"]);
  crossOrigin(neighbourRead, "a cold read of a small file");
  const fromMemory = await visit(site, "/a.css", { headers: { origin } });
  assert.equal(fromMemory.text, files["a.css"]);
  crossOrigin(fromMemory, "a neighbour kept in memory");
  const again = await visit(site, "/b.js", { headers: { origin } });
  crossOrigin(again, "a file served from memory");
  const etag = again.headers.etag ?? "";

  writeFileSync(join(root, "index.html"), "<h1>Two</h1>");
  const second = await runCli(["--no-copy", "-n", name, root], { home });
  assert.equal(second.code, 0, second.stderr);
  const revalidated = await visit(site, "/b.js", { headers: { origin, "if-none-match": `W/${etag}` } });
  assert.equal(revalidated.status, 304, "an unchanged file keeps its ETag across the redeploy");
  crossOrigin(revalidated, "a 304");
  const changed = await visit(site, "/", { headers: { origin } });
  assert.equal(changed.text, "<h1>Two</h1>");
  crossOrigin(changed, "a changed page");
});

test("a deploy made of files from more than eight earlier deploys still deploys", { timeout: 60_000 }, async () => {
  const home = newHome();
  const files: Record<string, Buffer> = {};
  for (let number = 0; number < 10; number += 1) {
    const name = `part-${number}.bin`;
    files[name] = randomBytes(3000);
    await deploy(["--no-copy", folder({ [name]: files[name] })], { home });
  }
  const { url } = await deploy(["--no-copy", folder(files)], { home });
  await expectServed(url, files);
});

test("a change to _redirects or _headers takes effect on the next deploy, and unchanged rule files are reused", async () => {
  const proxy = await countingProxy();
  try {
    const home = newHome();
    const files: Record<string, string | Buffer> = {
      "index.html": "<h1>One</h1>",
      "b.html": "<h1>B</h1>",
      "c.html": "<h1>C</h1>",
      "photo.jpg": randomBytes(30_000),
      _redirects: `/a  /b  301\n${"# padding so the rule file is worth reusing\n".repeat(200)}`,
      _headers: `/*\n  X-Version: one\n${"# padding so the rule file is worth reusing\n".repeat(200)}`
    };
    const root = folder(files);
    const name = uniqueName("rules");
    const run = async (): Promise<string> => {
      const result = await runCli(["--no-copy", "-n", name, root], { home, env: { SITE_URL: proxy.url } });
      assert.equal(result.code, 0, result.stderr);
      return result.stdout.trim();
    };
    const site = await run();
    assert.equal((await visit(site, "/a")).headers.location, "/b");
    assert.equal((await visit(site, "/")).headers["x-version"], "one");

    writeFileSync(join(root, "_redirects"), `/a  /c  301\n${"# padding so the rule file is worth reusing\n".repeat(200)}`);
    await run();
    assert.equal((await visit(site, "/a")).headers.location, "/c", "a changed _redirects takes effect");
    assert.equal((await visit(site, "/")).headers["x-version"], "one");

    const before = proxy.sent();
    writeFileSync(join(root, "index.html"), "<h1>Two</h1>");
    await run();
    const sent = proxy.sent() - before;
    assert.ok(sent < 4_000, `the unchanged rule files and photo are reused: ${sent} bytes sent`);
    assert.equal((await visit(site, "/a")).headers.location, "/c", "rules still apply when their files are reused");
    const page = await visit(site, "/");
    assert.equal(page.text, "<h1>Two</h1>");
    assert.equal(page.headers["x-version"], "one");

    writeFileSync(join(root, "_headers"), `/*\n  X-Version: two\n${"# padding so the rule file is worth reusing\n".repeat(200)}`);
    await run();
    assert.equal((await visit(site, "/")).headers["x-version"], "two", "a changed _headers takes effect");
    assert.equal((await visit(site, "/_headers")).status, 404);
    assert.equal((await visit(site, "/_redirects")).status, 404);
  } finally {
    proxy.close();
  }
});

test("a reused file's validator changes with the site's header rules or its type, so new headers arrive with the body", async () => {
  const home = newHome();
  const photo = randomBytes(30_000);
  const root = folder({ "index.html": "<h1>One</h1>", "photo.jpg": photo, _headers: "/photo.jpg\n  X-Frame-Options: SAMEORIGIN\n" });
  const name = uniqueName("tagged");
  const site = (await deploy(["--no-copy", "-n", name, root], { home })).url;
  const first = await visit(site, "/photo.jpg");
  assert.equal(first.headers["x-frame-options"], "SAMEORIGIN");
  const etag = first.headers.etag ?? "";

  writeFileSync(join(root, "index.html"), "<h1>Two</h1>");
  await deploy(["--no-copy", "-n", name, root], { home });
  const unchanged = await visit(site, "/photo.jpg", { headers: { "if-none-match": etag } });
  assert.equal(unchanged.status, 304, "the same rules keep the reused file's validator");
  assert.equal(unchanged.headers["x-frame-options"], "SAMEORIGIN", "a 304 carries the header rules");

  writeFileSync(join(root, "_headers"), "/photo.jpg\n  X-Frame-Options: DENY\n");
  await deploy(["--no-copy", "-n", name, root], { home });
  const changed = await visit(site, "/photo.jpg", { headers: { "if-none-match": etag } });
  assert.equal(changed.status, 200, "changed rules change the validator");
  assert.notEqual(changed.headers.etag, etag);
  assert.equal(changed.headers["x-frame-options"], "DENY");
  assert.ok(changed.body.equals(photo));

  const text = "plain words that later become a page";
  const typed = folder({ "photo.jpg": photo, notes: text });
  const typedName = uniqueName("typed");
  const typedSite = (await deploy(["--no-copy", "-n", typedName, typed], { home })).url;
  const asText = await visit(typedSite, "/notes");
  assert.equal(asText.headers["content-type"], "text/plain; charset=utf-8");
  rmSync(join(typed, "notes"));
  writeFileSync(join(typed, "notes.html"), text);
  await deploy(["--no-copy", "-n", typedName, typed], { home });
  const asPage = await visit(typedSite, "/notes", { headers: { "if-none-match": asText.headers.etag ?? "" } });
  assert.equal(asPage.status, 200, "the same bytes under another type get a new validator");
  assert.equal(asPage.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(asPage.text, text);
});

test("rewrites, folded names, 404 pages and app fallbacks serve the right bytes and validator, from memory too, with their header rules", async () => {
  const files: Record<string, string> = {
    "index.html": "<h1>Home</h1>",
    "target.html": "<h1>Target</h1>",
    "About.html": "<h1>About</h1>",
    "404.html": "<h1>Lost</h1>",
    _redirects: "/rewritten  /target.html  200\n",
    _headers: "/rewritten\n  X-Path: rewritten\n/about\n  X-Path: about\n/*\n  X-Site: yes\n/target.html\n  Cache-Control: max-age=60\n"
  };
  const root = folder(files);
  const name = uniqueName("routes");
  const home = newHome();
  const named = (await deploy(["--no-copy", "-n", name, root], { home })).url;
  const { label } = await deploy(["--no-copy", root], { home });
  const byId = idUrl(label);

  for (const site of [named, byId]) {
    const target = await visit(site, "/target.html");
    for (let round = 0; round < 2; round += 1) {
      const rewritten = await visit(site, "/rewritten");
      assert.equal(rewritten.text, files["target.html"]);
      assert.equal(rewritten.headers.etag, target.headers.etag, "a rewrite carries its target's validator");
      assert.equal(rewritten.headers["x-path"], "rewritten");
      assert.equal(rewritten.headers["x-site"], "yes");
      const revalidated = await visit(site, "/rewritten", { headers: { "if-none-match": target.headers.etag ?? "" } });
      assert.equal(revalidated.status, 304);
      assert.equal(revalidated.headers["x-path"], "rewritten", "a 304 carries the rules of the requested path");

      const folded = await visit(site, "/about");
      assert.equal(folded.text, files["About.html"]);
      assert.equal(folded.headers.etag, (await visit(site, "/About.html")).headers.etag);
      assert.equal(folded.headers["x-path"], "about");

      const lost = await visit(site, "/nowhere", { headers: { "if-none-match": (await visit(site, "/404.html")).headers.etag ?? "" } });
      assert.equal(lost.status, 404, "a 404 page is never a 304");
      assert.equal(lost.text, files["404.html"]);
      assert.equal(lost.headers["x-site"], "yes");
    }
  }
  assert.equal((await visit(byId, "/target.html")).headers["cache-control"], "max-age=60, no-transform", "a site's Cache-Control holds on id hosts");
  assert.equal((await visit(named, "/target.html")).headers["cache-control"], "no-cache, no-transform", "named hosts keep revalidating");

  const app: Record<string, string> = { "index.html": '<div id="app"></div><script src="/app.js"></script>', "app.js": "document.title = 'app';", _headers: "/users/*\n  X-Route: user\n" };
  const appSite = (await deploy(["--no-copy", folder(app)], { home })).url;
  const shell = await visit(appSite, "/index.html");
  for (let round = 0; round < 2; round += 1) {
    const route = await visit(appSite, "/users/42");
    assert.equal(route.text, app["index.html"]);
    assert.equal(route.headers.etag, shell.headers.etag, "the app fallback carries the shell's validator");
    assert.equal(route.headers["x-route"], "user");
  }
});
