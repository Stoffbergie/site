import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test } from "vite-plus/test";
import { adminToken, apiKeyOf, baseUrl, deploy, folder, idUrl, newHome, runCli, uniqueName, upload, visit } from "../helpers/site";

const admin = { authorization: `Bearer ${adminToken}` };

function ownerOf(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function deployIds(key: string): Promise<string[]> {
  const listed = await fetch(`${baseUrl}/list`, { headers: { authorization: `Bearer ${key}` } });
  return ((await listed.json()) as { deploys: { id: string }[] }).deploys.map((deployed) => deployed.id);
}

function uploadBlockedMidway(key: string, owner: string): Promise<{ status: number; body: string }> {
  const first = Buffer.from("<h1>started before the block</h1>");
  const rest = Buffer.alloc(200_000, 0x20);
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${key}`, "content-length": String(first.byteLength + rest.byteLength) };
    const request = httpRequest({ host: "127.0.0.1", port: new URL(baseUrl).port, path: "/page.html", method: "PUT", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.write(first);
    setTimeout(() => void answer(`/blocked/${owner}`, "PUT", admin).then(() => request.end(rest)), 1000);
  });
}

async function answer(path: string, method: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}${path}`, { method, headers });
  return { status: response.status, body: await response.text() };
}

test("the takedown token looks up who owns a deploy and a name, and to everyone else those paths do not exist", async () => {
  const home = newHome();
  const key = await apiKeyOf(home);
  const owner = ownerOf(key);
  const name = uniqueName("lookup");
  await deploy(["--no-copy", "-n", name, folder({ "index.html": "<h1>looked up</h1>" })], { home });
  const [id] = await deployIds(key);

  const deployInfo = await fetch(`${baseUrl}/deploys/${id}`, { headers: admin });
  assert.equal(deployInfo.status, 200);
  const shown = (await deployInfo.json()) as Record<string, unknown>;
  assert.equal(shown.id, id);
  assert.equal(shown.owner, owner);
  assert.equal(shown.files, 1);
  assert.ok(Number(shown.size) > 0);
  assert.ok(!Number.isNaN(Date.parse(String(shown.createdAt))));
  assert.equal(shown.encrypted, null);

  const nameInfo = await fetch(`${baseUrl}/names/${name}`, { headers: admin });
  assert.deepEqual(await nameInfo.json(), { name, id, owner, releasedBy: null });
  assert.equal((await answer("/deploys/zzzz2222", "GET", admin)).status, 404);
  assert.equal((await answer(`/blocked/${owner.toUpperCase()}`, "PUT", admin)).status, 400);

  const callers: Record<string, string>[] = [{}, { authorization: `Bearer ${key}` }, { authorization: "Bearer not-a-key" }];
  for (const headers of callers) {
    const unknownGet = await answer("/no-such/route", "GET", headers);
    assert.deepEqual(await answer(`/deploys/${id}`, "GET", headers), unknownGet);
    assert.deepEqual(await answer(`/names/${name}`, "GET", headers), unknownGet);
    const unknownPut = await answer("/no-such/route", "PUT", headers);
    assert.deepEqual(await answer(`/blocked/${owner}`, "PUT", headers), unknownPut);
    const unknownDelete = await answer("/no-such/route", "DELETE", headers);
    assert.deepEqual(await answer(`/blocked/${owner}`, "DELETE", headers), unknownDelete);
    assert.deepEqual(await answer(`/owners/${owner}`, "DELETE", headers), unknownDelete);
  }
  assert.equal((await visit(`https://${name}.site.localhost`)).text, "<h1>looked up</h1>");
});

test("a blocked key is refused on every API call until it is unblocked, and its sites stay up", async () => {
  const home = newHome();
  const key = await apiKeyOf(home);
  const owner = ownerOf(key);
  const name = uniqueName("blocked");
  const site = folder({ "index.html": "<h1>still here</h1>" });
  const first = await deploy(["--no-copy", "-n", name, site], { home });
  const [id] = await deployIds(key);

  assert.deepEqual(await answer(`/blocked/${owner}`, "PUT", admin), { status: 200, body: "blocked\n" });
  for (const args of [["--no-copy", site], ["ls"], ["point", name, id], ["rm", id], ["rm", name]]) {
    const refused = await runCli(args, { home });
    assert.notEqual(refused.code, 0, `site ${args.join(" ")} was allowed`);
    assert.match(refused.stderr, /this key is blocked/i);
  }
  const curl = await upload("/page.html", "<h1>x</h1>", { authorization: `Bearer ${key}` });
  assert.equal(curl.status, 403);
  assert.match(curl.text, /^This key is blocked for abuse; report a mistake at https:\/\/github\.com\/Stoffbergie\/site\/issues\.\n$/);
  assert.equal((await visit(first.url)).text, "<h1>still here</h1>");
  assert.equal((await upload("/page.html", "<h1>someone else</h1>", { authorization: `Bearer ${await apiKeyOf(newHome())}` })).status, 201);

  assert.deepEqual(await answer(`/blocked/${owner}`, "DELETE", admin), { status: 200, body: "unblocked\n" });
  const before = await deployIds(key);
  const midway = await uploadBlockedMidway(key, owner);
  assert.equal(midway.status, 403, midway.body);
  assert.deepEqual(await answer(`/blocked/${owner}`, "DELETE", admin), { status: 200, body: "unblocked\n" });
  assert.deepEqual(await deployIds(key), before);
  assert.equal((await runCli(["--no-copy", "-n", name, site], { home })).code, 0);
});

test("clearing out a key deletes every deploy it has and releases its names for good", async () => {
  const home = newHome();
  const key = await apiKeyOf(home);
  const owner = ownerOf(key);
  const first = uniqueName("cleared");
  const second = uniqueName("cleared");
  await deploy(["--no-copy", "-n", first, folder({ "index.html": "<h1>one</h1>" })], { home });
  await deploy(["--no-copy", "-n", second, folder({ "index.html": "<h1>two</h1>" })], { home });
  await deploy(["--no-copy", folder({ "index.html": "<h1>three</h1>" })], { home });
  const ids = await deployIds(key);
  assert.equal(ids.length, 3);
  const bystander = await deploy(["--no-copy", folder({ "index.html": "<h1>bystander</h1>" })]);

  assert.deepEqual(await answer(`/owners/${owner}`, "DELETE", admin), { status: 200, body: "Removed 3 deploys and released 2 names.\n" });

  for (const id of ids) assert.equal((await visit(idUrl(id))).status, 404);
  assert.equal((await visit(`https://${first}.site.localhost`)).status, 404);
  const ls = await runCli(["ls"], { home });
  assert.match(ls.stderr, /No deploys yet/);
  const reclaim = await runCli(["--no-copy", "-n", first, folder({ "index.html": "again" })], { home });
  assert.match(reclaim.stderr, /that name is taken/);
  const stranger = await runCli(["--no-copy", "-n", second, folder({ "index.html": "theirs" })]);
  assert.match(stranger.stderr, /that name is taken/);
  assert.equal((await visit(bystander.url)).text, "<h1>bystander</h1>");
});
