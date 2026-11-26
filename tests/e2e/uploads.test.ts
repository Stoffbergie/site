import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, ftruncateSync } from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { inject, test } from "vite-plus/test";
import { adminToken, apiKeyOf, baseUrl, folder, newHome, runCli, upload, visit, type Run } from "../helpers/site";

function pack(index: unknown, data: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(index));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.byteLength);
  return Buffer.concat([Buffer.from("SITEPACK1\n"), length, json, data]);
}

test("curl -T deploys a single file with its type taken from the filename", async () => {
  const root = folder({ "page.html": "<h1>From curl</h1>" });
  const printed = execFileSync("curl", ["-fsS", "-T", join(root, "page.html"), baseUrl], { encoding: "utf8" });
  assert.match(printed, /^https:\/\/[a-z0-9]{8}\.site\.localhost\n$/);
  const url = printed.trim();

  const home = await visit(url, "/");
  assert.equal(home.text, "<h1>From curl</h1>");
  assert.equal(home.headers["content-type"], "text/html; charset=utf-8");
  assert.equal((await visit(url, "/page.html")).text, "<h1>From curl</h1>");
});

test("a pack is deployed exactly as described by its index", async () => {
  const index = {
    spa: false,
    files: [
      { path: "index.html", offset: 0, length: 5, type: "text/html; charset=utf-8", gzip: false },
      { path: "a/b.txt", offset: 5, length: 3, type: "text/plain; charset=utf-8", gzip: false }
    ]
  };
  const response = await upload("/", pack(index, Buffer.from("hello123")), { accept: "application/json" }, "POST");
  assert.equal(response.status, 201, response.text);
  const deployed = JSON.parse(response.text) as { url: string; files: number; size: number };
  assert.equal(deployed.files, 2);
  assert.equal(deployed.size, 8);
  assert.equal((await visit(deployed.url, "/")).text, "hello");
  assert.equal((await visit(deployed.url, "/a/b.txt")).text, "123");
});

test("an exact name wins and a name that folds to two files matches neither", async () => {
  const nfc = "Café.html".normalize("NFC");
  const nfd = "café.html".normalize("NFD");
  const names = ["About.html", "about.html", nfc, nfd, "404.html"];
  let offset = 0;
  const files = names.map((path) => {
    const entry = { path, offset, length: Buffer.byteLength(path), type: "text/html; charset=utf-8", gzip: false };
    offset += entry.length;
    return entry;
  });
  const response = await upload("/", pack({ spa: false, files }, Buffer.from(names.join(""))), { accept: "application/json" }, "POST");
  assert.equal(response.status, 201, response.text);
  const { url } = JSON.parse(response.text) as { url: string };

  assert.equal((await visit(url, "/About.html")).text, "About.html");
  assert.equal((await visit(url, "/about")).text, "about.html");
  assert.equal((await visit(url, `/${encodeURIComponent(nfd)}`)).text, nfd);
  for (const path of ["/ABOUT.html", "/ABOUT", `/${encodeURIComponent("CAFÉ.html")}`]) {
    const reply = await visit(url, path);
    assert.equal(reply.status, 404, path);
    assert.equal(reply.text, "404.html", path);
  }
});

test.each([
  ["offsets that skip bytes", { spa: false, files: [{ path: "index.html", offset: 2, length: 3, type: "text/html", gzip: false }] }, "hello", /offsets do not line up/],
  ["lengths that overrun the upload", { spa: false, files: [{ path: "index.html", offset: 0, length: 50, type: "text/html", gzip: false }] }, "hello", /do not add up/],
  ["a path that climbs out", { spa: false, files: [{ path: "../etc/passwd", offset: 0, length: 5, type: "text/plain", gzip: false }] }, "hello", /bad path/],
  [
    "a duplicate path",
    {
      spa: false,
      files: [
        { path: "a", offset: 0, length: 2, type: "text/plain", gzip: false },
        { path: "a", offset: 2, length: 3, type: "text/plain", gzip: false }
      ]
    },
    "hello",
    /twice/
  ],
  ["no spa flag", { files: [{ path: "a", offset: 0, length: 5, type: "text/plain", gzip: false }] }, "hello", /spa/]
])("a pack with %s is refused and leaves nothing behind", async (_, index, data, message) => {
  const home = newHome();
  const key = await apiKeyOf(home);
  const response = await upload("/", pack(index, Buffer.from(data)), { authorization: `Bearer ${key}` }, "POST");
  assert.equal(response.status, 400);
  assert.match(response.text, message);
  assert.match((await runCli(["ls"], { home })).stderr, /No deploys yet/);
});

test("a pack whose index is not JSON is refused", async () => {
  const bytes = Buffer.concat([Buffer.from("SITEPACK1\n"), Buffer.from([0, 0, 0, 3]), Buffer.from("{{{")]);
  const response = await upload("/", bytes, {}, "POST");
  assert.equal(response.status, 400);
  assert.match(response.text, /not valid JSON/);
});

test("the CLI checks the 100 MB limit before uploading", async () => {
  const root = folder({ "index.html": "x" });
  const handle = openSync(join(root, "huge.bin"), "w");
  ftruncateSync(handle, 100_000_001);
  closeSync(handle);
  const home = newHome();
  const result = await runCli(["--no-copy", root], { home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^site: this deploy is 95\.4 MB and the limit is 100 MB; leave out large files or host them elsewhere\n$/);
  assert.match((await runCli(["ls"], { home })).stderr, /No deploys yet/);
});

function withFewDescriptors(descriptors: number, args: string[]): Promise<Run> {
  const home = newHome();
  const script = `ulimit -n ${descriptors}; exec "$0" "$@"`;
  const child = spawn("/bin/sh", ["-c", script, inject("cli"), ...args], { env: { ...process.env, SITE_URL: baseUrl, HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1" } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end();
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

test("a deploy with many more large files than the CLI may hold open lands whole", { timeout: 120_000 }, async () => {
  const photos: Record<string, Buffer> = {};
  for (let number = 0; number < 85; number += 1) photos[`photos/${number}.jpg`] = randomBytes(1_100_000);
  const run = await withFewDescriptors(48, ["--no-copy", folder({ "index.html": "<h1>album</h1>", ...photos })]);
  assert.equal(run.code, 0, run.stderr);
  const url = run.stdout.trim();
  for (const [path, bytes] of Object.entries(photos)) {
    const served = await visit(url, `/${path}`, { headers: { "accept-encoding": "identity" } });
    assert.equal(served.status, 200, path);
    assert.ok(served.body.equals(bytes), `${path} has the deployed bytes`);
  }
});

test("the CLI explains what it needs when given nothing to deploy", async () => {
  assert.match((await runCli([])).stderr, /give a folder or files to deploy/);
  assert.match((await runCli(["--no-copy", folder({ ".hidden": "x" })])).stderr, /has nothing to deploy/);
  assert.match((await runCli(["--no-copy", "/no/such/place"])).stderr, /could not find \/no\/such\/place/);
});

test("deploys without a key get ids under d/0 for the 7 day lifecycle rule, and owned deploys never do", async () => {
  const home = newHome();
  const key = await apiKeyOf(home);
  const unowned: string[] = [];
  const owned: string[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const anonymous = await upload("/page.html", `<h1>anonymous ${attempt}</h1>`);
    assert.equal(anonymous.status, 201, anonymous.text);
    unowned.push(new URL(anonymous.text.trim()).hostname.split(".")[0]);
    const withKey = await upload("/page.html", `<h1>owned ${attempt}</h1>`, { authorization: `Bearer ${key}` });
    assert.equal(withKey.status, 201, withKey.text);
    owned.push(new URL(withKey.text.trim()).hostname.split(".")[0]);
  }
  const cli = await runCli(["--no-copy", folder({ "index.html": "<h1>cli</h1>" })], { home });
  assert.equal(cli.code, 0, cli.stderr);
  owned.push(new URL(cli.stdout.trim()).hostname.split(".")[0]);

  for (const id of unowned) assert.match(id, /^0[a-z0-9]{7}$/);
  for (const id of owned) assert.match(id, /^[1-9a-z][a-z0-9]{7}$/);
  assert.equal((await visit(`https://${unowned[0]}.site.localhost`, "/")).text, "<h1>anonymous 0</h1>");

  const removed = await upload(`/deploys/${unowned[0]}`, "", { authorization: `Bearer ${adminToken}` }, "DELETE");
  assert.equal(removed.status, 200, removed.text);

  const usage = await (await fetch(baseUrl)).text();
  assert.match(usage, /made without one are removed after 7 days/);
});
