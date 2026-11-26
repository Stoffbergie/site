import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "vite-plus/test";
import { deploy, folder, hostOf, idUrl, keyOf, newHome, runCli, uniqueName, upload, visit } from "../helpers/site";

const linkShape = /^https:\/\/([a-z0-9-]+)\.site\.localhost\/#[A-Za-z0-9_-]{43}$/;

test("an encrypted deploy stores and serves no file names, types or contents", async () => {
  const secret = "the-launch-date-is-friday";
  const photo = randomBytes(4000);
  const root = folder({ "index.html": `<h1>${secret}</h1>`.repeat(50), "secret-plans.txt": secret, "photo.png": photo });
  const { url, run } = await deploy(["--no-copy", "-e", root]);
  assert.match(url, linkShape);
  assert.match(run.stderr, /3 files/);
  const host = hostOf(url);

  const meta = await visit(host, "/__site/meta");
  assert.equal(meta.status, 200);
  assert.equal(meta.headers["cache-control"], "no-cache, no-transform");
  const { id, encrypted, entries } = JSON.parse(meta.text) as { id: string; encrypted: Record<string, string>; entries: number[] };
  assert.equal(`https://${id}.site.localhost`, host);
  assert.deepEqual(Object.keys(encrypted).sort(), ["contentSalt", "linkSalt"]);
  assert.equal(entries.length, 4);

  const stored = [meta.body];
  for (const [number, length] of entries.entries()) {
    const entry = await visit(host, `/__site/entries/${number}`);
    assert.equal(entry.status, 200);
    assert.equal(entry.headers["content-type"], "application/octet-stream");
    assert.equal(entry.headers["cache-control"], "public, max-age=31536000, immutable, no-transform");
    assert.equal(entry.body.byteLength, length);
    stored.push(entry.body);
  }
  const everything = Buffer.concat(stored);
  for (const needle of [secret, "index.html", "secret-plans", "photo.png", "text/html", "image/png", "<h1>"]) {
    assert.equal(everything.includes(needle), false, `${needle} is not stored in the clear`);
  }
  assert.equal(everything.includes(photo.subarray(1000, 1032)), false, "the photo is not stored in the clear");

  const range = await visit(host, "/__site/entries/3", { headers: { range: "bytes=0-9" } });
  assert.equal(range.status, 206);
  assert.equal(range.body.byteLength, 10);
});

test("every path without the key gets the same private bootstrap page", async () => {
  const { url } = await deploy(["--no-copy", "-e", folder({ "index.html": "<h1>Hidden</h1>", "about.html": "about" })]);
  const host = hostOf(url);
  for (const path of ["/", "/about", "/index.html", "/nowhere/at/all"]) {
    const page = await visit(host, path, { headers: { accept: "text/html" } });
    assert.equal(page.status, 200);
    assert.equal(page.headers["cache-control"], "no-cache, no-transform");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.match(page.text, /This site is private/);
    assert.match(page.text, /<script src="\/__site\/boot\.js"><\/script>/);
    assert.doesNotMatch(page.text, /Hidden|about/);
  }

  const worker = await visit(host, "/__site/sw.js");
  assert.equal(worker.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(worker.headers["service-worker-allowed"], "/");
  assert.equal((await visit(host, "/__site/entries/9")).status, 404);
});

test("a named encrypted link is the same after every redeploy and on a second machine", async () => {
  const laptop = newHome();
  const name = uniqueName("private");
  const first = await deploy(["--no-copy", "-e", "-n", name, folder({ "index.html": "one" })], { home: laptop });
  assert.match(first.url, new RegExp(`^https://${name}\\.site\\.localhost/#[A-Za-z0-9_-]{43}$`));
  const fragment = first.url.split("#")[1];
  assert.match(first.run.stderr, new RegExp(`^https://[a-z0-9]{8}\\.site\\.localhost/#${fragment} · 1 file`, "m"));

  const second = await deploy(["--no-copy", "-e", "-n", name, folder({ "index.html": "two" })], { home: laptop });
  assert.equal(second.url, first.url);

  const desktop = newHome();
  await runCli(["key", await keyOf(laptop)], { home: desktop });
  const third = await deploy(["--no-copy", "-e", "-n", name, folder({ "index.html": "three" })], { home: desktop });
  assert.equal(third.url, first.url);

  const unnamed = await deploy(["--no-copy", "-e", folder({ "index.html": "x" })], { home: laptop });
  const again = await deploy(["--no-copy", "-e", folder({ "index.html": "x" })], { home: laptop });
  assert.notEqual(unnamed.url.split("#")[1], again.url.split("#")[1], "unnamed deploys get their own keys");
});

test("a name holding an encrypted site refuses a public deploy, and a public name can become encrypted", async () => {
  const home = newHome();
  const name = uniqueName("locked");
  const { url } = await deploy(["--no-copy", "-e", "-n", name, folder({ "index.html": "private" })], { home });

  const refused = await runCli(["--no-copy", "-n", name, folder({ "index.html": "public" })], { home });
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.equal(refused.stderr, `site: ${name} holds an encrypted site; deploy with -e to keep it private, or release it with site rm ${name} first\n`);
  assert.match((await visit(hostOf(url), "/")).text, /This site is private/);

  const opened = uniqueName("opened");
  await deploy(["--no-copy", "-n", opened, folder({ "index.html": "public first" })], { home });
  const encrypted = await deploy(["--no-copy", "-e", "-n", opened, folder({ "index.html": "private now" })], { home });
  assert.match(encrypted.url, linkShape);
  assert.match((await visit(hostOf(encrypted.url), "/")).text, /This site is private/);
});

test("point moves a name only onto deploys encrypted for that name", async () => {
  const home = newHome();
  const name = uniqueName("pointed");
  const first = await deploy(["--no-copy", "-e", "-n", name, folder({ "index.html": "first" })], { home });
  const firstId = /https:\/\/([a-z0-9]{8})\./.exec(first.run.stderr)?.[1] as string;
  await deploy(["--no-copy", "-e", "-n", name, folder({ "index.html": "second" })], { home });

  const back = await runCli(["point", name, firstId], { home });
  assert.equal(back.code, 0, back.stderr);
  assert.equal(back.stdout, `${first.url}\n`);

  const unnamed = await deploy(["--no-copy", "-e", folder({ "index.html": "own link" })], { home });
  const unnamedId = new URL(unnamed.url).hostname.split(".")[0];
  const foreign = await runCli(["point", name, unnamedId], { home });
  assert.equal(foreign.code, 1);
  assert.equal(foreign.stderr, `site: ${unnamedId} was encrypted for its own link, so the link for ${name} could not open it; deploy again with site -e -n ${name}\n`);

  const plain = await deploy(["--no-copy", folder({ "index.html": "public" })], { home });
  const publicId = new URL(plain.url).hostname.split(".")[0];
  const exposed = await runCli(["point", name, publicId], { home });
  assert.equal(exposed.code, 1);
  assert.match(exposed.stderr, new RegExp(`site: ${name} holds an encrypted site`));

  const other = uniqueName("other");
  const otherName = await deploy(["--no-copy", "-e", "-n", other, folder({ "index.html": "other" })], { home });
  const otherId = /https:\/\/([a-z0-9]{8})\./.exec(otherName.run.stderr)?.[1] as string;
  const crossed = await runCli(["point", name, otherId], { home });
  assert.equal(crossed.code, 1);
  assert.match(crossed.stderr, /was encrypted for its own link/);
});

test("site ls marks encrypted names and deploys and prints their full links", async () => {
  const home = newHome();
  const name = uniqueName("listed");
  const named = await deploy(["--no-copy", "-e", "-n", name, folder({ "index.html": "named" })], { home });
  const namedId = /https:\/\/([a-z0-9]{8})\./.exec(named.run.stderr)?.[1] as string;
  const unnamed = await deploy(["--no-copy", "-e", folder({ "index.html": "unnamed" })], { home });
  const plain = await deploy(["--no-copy", folder({ "index.html": "plain" })], { home });

  const listed = await runCli(["ls"], { home });
  assert.equal(listed.code, 0, listed.stderr);
  const lines = listed.stdout.split("\n");
  const line = (start: string) => lines.find((candidate) => candidate.startsWith(start)) ?? "";
  assert.match(line(named.url), new RegExp(`→ ${namedId}  encrypted$`));
  assert.match(line(`${idUrl(namedId)}/#${named.url.split("#")[1]}`), /encrypted$/);
  assert.match(line(unnamed.url), /1 file  encrypted$/);
  assert.match(line(plain.url), /1 file$/);
});

test("the server refuses encrypted packs that carry anything but offsets and lengths", async () => {
  const salt = "A".repeat(22);
  const pack = (index: unknown, data: Buffer) => {
    const json = Buffer.from(JSON.stringify(index));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.byteLength);
    return Buffer.concat([Buffer.from("SITEPACK1\n"), length, json, data]);
  };
  const leaky = {
    encrypted: { linkSalt: salt, contentSalt: salt },
    files: [
      { offset: 0, length: 20 },
      { offset: 20, length: 20, path: "index.html" }
    ]
  };
  const leakyReply = await upload("/", pack(leaky, randomBytes(40)), {}, "POST");
  assert.equal(leakyReply.status, 400);
  assert.match(leakyReply.text, /must have only an offset and a length/);

  const misaligned = {
    encrypted: { linkSalt: salt, contentSalt: salt },
    files: [
      { offset: 0, length: 20 },
      { offset: 21, length: 19 }
    ]
  };
  assert.equal((await upload("/", pack(misaligned, randomBytes(40)), {}, "POST")).status, 400);

  const short = {
    encrypted: { linkSalt: salt, contentSalt: salt },
    files: [
      { offset: 0, length: 20 },
      { offset: 20, length: 30 }
    ]
  };
  assert.equal((await upload("/", pack(short, randomBytes(40)), {}, "POST")).status, 400);
});

test("the part of the key that makes private links is never sent to the server", async () => {
  const home = newHome();
  const key = await keyOf(home);
  const [apiPart, privatePart] = key.split(".");
  const seen: string[] = [];
  const recorder = createServer((request, response) => {
    seen.push(`${request.url} ${JSON.stringify(request.headers)}`);
    request.resume();
    request.on("end", () => response.writeHead(400).end("stop here\n"));
  });
  await new Promise<void>((resolve) => recorder.listen(0, "127.0.0.1", resolve));
  const recorderUrl = `http://127.0.0.1:${(recorder.address() as AddressInfo).port}`;
  try {
    const root = folder({ "index.html": "x" });
    await runCli(["--no-copy", "-e", "-n", uniqueName("quiet"), root], { home, env: { SITE_URL: recorderUrl } });
    await runCli(["ls"], { home, env: { SITE_URL: recorderUrl } });
  } finally {
    await new Promise((resolve) => recorder.close(resolve));
  }
  assert.equal(seen.length, 2);
  for (const request of seen) {
    assert.ok(request.includes(`Bearer ${apiPart}"`), "the login part authenticates");
    assert.ok(!request.includes(privatePart), "the private part stays on the machine");
  }
});

test("the CLI never follows a redirect, so a request is never sent twice or somewhere else", async () => {
  const elsewhere: string[] = [];
  const target = createServer((request, response) => {
    elsewhere.push(`${request.method} ${request.url}`);
    request.resume();
    request.on("end", () => response.writeHead(200).end("released\n"));
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  const redirecting: string[] = [];
  const redirector = createServer((request, response) => {
    redirecting.push(`${request.method} ${request.url}`);
    request.resume();
    request.on("end", () => response.writeHead(303, { Location: `${targetUrl}/names/moved` }).end());
  });
  await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  const redirectorUrl = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`;
  try {
    const removed = await runCli(["rm", "some-name"], { env: { SITE_URL: redirectorUrl } });
    assert.equal(removed.code, 1);
    const pointed = await runCli(["point", "some-name", "abcd1234"], { env: { SITE_URL: redirectorUrl } });
    assert.equal(pointed.code, 1);
  } finally {
    await new Promise((resolve) => target.close(resolve));
    await new Promise((resolve) => redirector.close(resolve));
  }
  assert.deepEqual(redirecting, ["DELETE /names/some-name", "PUT /names/some-name"]);
  assert.deepEqual(elsewhere, []);
});
