import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { adminToken, baseUrl, deploy, folder, idUrl, apiKeyOf, keyOf, newHome, runCli, uniqueName, upload, visit } from "../helpers/site";

test("a name points at the latest deploy and a redeploy is visible on the very next load", async () => {
  const home = newHome();
  const name = uniqueName("todo");
  const first = await deploy(["--no-copy", "-n", name, folder({ "index.html": "<h1>One</h1>" })], { home });
  assert.equal(first.url, `https://${name}.site.localhost`);
  const firstId = /https:\/\/([a-z0-9]{8})\.site\.localhost/.exec(first.run.stderr)?.[1];
  assert.ok(firstId, `the per-deploy URL goes to stderr: ${first.run.stderr}`);

  const before = await visit(first.url);
  assert.equal(before.text, "<h1>One</h1>");
  assert.equal(before.headers["cache-control"], "no-cache, no-transform");
  const revalidated = await visit(first.url, "/", { headers: { "if-none-match": before.headers.etag as string } });
  assert.equal(revalidated.status, 304);

  await deploy(["--no-copy", "-n", name, folder({ "index.html": "<h1>Two</h1>" })], { home });
  const after = await visit(first.url, "/", { headers: { "if-none-match": before.headers.etag as string } });
  assert.equal(after.status, 200);
  assert.equal(after.text, "<h1>Two</h1>");
  assert.equal((await visit(idUrl(firstId), "/")).text, "<h1>One</h1>", "the old deploy keeps its own URL");
});

test("another key cannot take a name", async () => {
  const name = uniqueName("mine");
  await deploy(["--no-copy", "-n", name, folder({ "index.html": "owner" })]);
  const stranger = await runCli(["--no-copy", "-n", name, folder({ "index.html": "stranger" })]);
  assert.equal(stranger.code, 1);
  assert.equal(stranger.stdout, "");
  assert.match(stranger.stderr, /^site: that name is taken; pick another\n$/);
  assert.equal((await visit(`https://${name}.site.localhost`)).text, "owner");
});

test("the same key on a second machine redeploys, lists and rolls back with point", async () => {
  const laptop = newHome();
  const name = uniqueName("shared");
  const first = await deploy(["--no-copy", "-n", name, folder({ "index.html": "from laptop" })], { home: laptop });
  const firstId = /https:\/\/([a-z0-9]{8})\./.exec(first.run.stderr)?.[1] as string;

  const desktop = newHome();
  const saved = await runCli(["key", await keyOf(laptop)], { home: desktop });
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(await keyOf(desktop), await keyOf(laptop));

  await deploy(["--no-copy", "-n", name, folder({ "index.html": "from desktop" })], { home: desktop });
  assert.equal((await visit(first.url)).text, "from desktop");

  const listed = await runCli(["ls"], { home: laptop });
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(`https://${name}\\.site\\.localhost\\s+→ [a-z0-9]{8}`));
  assert.equal(listed.stdout.match(/^https:\/\/[a-z0-9]{8}\.site\.localhost\s+(just now|\dm ago)\s+\d+ B\s+1 file$/gm)?.length, 2, listed.stdout);

  const pointed = await runCli(["point", name, firstId], { home: desktop });
  assert.equal(pointed.code, 0, pointed.stderr);
  assert.equal(pointed.stdout, `${first.url}\n`);
  assert.equal((await visit(first.url)).text, "from laptop");
});

test("rm refuses a deploy a name points at, then releases the name and deletes the deploy", async () => {
  const home = newHome();
  const name = uniqueName("gone");
  const { run } = await deploy(["--no-copy", "-n", name, folder({ "index.html": "bye" })], { home });
  const id = /https:\/\/([a-z0-9]{8})\./.exec(run.stderr)?.[1] as string;

  const refused = await runCli(["rm", id], { home });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, new RegExp(`site: ${name} still points at ${id}; point it at another deploy or release it with site rm ${name} first`));

  const released = await runCli(["rm", name], { home });
  assert.equal(released.code, 0, released.stderr);
  assert.equal((await visit(`https://${name}.site.localhost`)).status, 404);

  const deleted = await runCli(["rm", id], { home });
  assert.equal(deleted.code, 0, deleted.stderr);
  assert.equal((await visit(idUrl(id))).status, 404);
  assert.doesNotMatch((await runCli(["ls"], { home })).stdout, new RegExp(id));
});

test("a key cannot remove another key's deploys or names, but the admin token can", async () => {
  const name = uniqueName("taken");
  const { run } = await deploy(["--no-copy", "-n", name, folder({ "index.html": "x" })]);
  const id = /https:\/\/([a-z0-9]{8})\./.exec(run.stderr)?.[1] as string;

  const strangerRemovesName = await runCli(["rm", name]);
  assert.match(strangerRemovesName.stderr, /site: that name belongs to another key/);
  const strangerRemovesDeploy = await runCli(["rm", id]);
  assert.match(strangerRemovesDeploy.stderr, /site: that deploy belongs to another key/);

  const admin = { Authorization: `Bearer ${adminToken}` };
  assert.equal((await fetch(`${baseUrl}/names/${name}`, { method: "DELETE", headers: admin })).status, 200);
  assert.equal((await fetch(`${baseUrl}/deploys/${id}`, { method: "DELETE", headers: admin })).status, 200);
  assert.equal((await visit(idUrl(id))).status, 404);
});

test.each([
  ["ab", /3 to 40 lowercase letters/],
  ["Has-Caps", /3 to 40 lowercase letters/],
  ["edge-", /3 to 40 lowercase letters/],
  ["a".repeat(41), /3 to 40 lowercase letters/],
  ["abcd2345", /look like deploy ids/],
  ["www", /reserved/],
  ["my-paypal-help", /not allowed/],
  ["bank", /not allowed/],
  ["secure-signin", /not allowed/]
])("the name %s is refused before anything uploads", async (name, message) => {
  const home = newHome();
  const result = await runCli(["--no-copy", "-n", name, folder({ "index.html": "x" })], { home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, message);
  const listed = await runCli(["ls"], { home });
  assert.match(listed.stderr, /No deploys yet/);
});

test("a key holds at most 20 names", async () => {
  const home = newHome();
  const key = await apiKeyOf(home);
  const headers = { Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const { run } = await deploy(["--no-copy", folder({ "index.html": "x" })], { home });
  const id = /https:\/\/([a-z0-9]{8})\./.exec(run.stdout)?.[1] as string;
  const prefix = uniqueName("many");
  for (let count = 0; count < 20; count += 1) {
    const response = await fetch(`${baseUrl}/names/${prefix}-${count}`, { method: "PUT", headers, body: JSON.stringify({ id }) });
    assert.equal(response.status, 200, await response.text());
  }
  const overLimit = await fetch(`${baseUrl}/names/${prefix}-20`, { method: "PUT", headers, body: JSON.stringify({ id }) });
  assert.equal(overLimit.status, 403);
  assert.match(await overLimit.text(), /20 names/);
});

test("naming a deploy needs a key", async () => {
  const response = await upload(`/page.html?name=${uniqueName("anon")}`, "<h1>hi</h1>");
  assert.equal(response.status, 401);
});

test("a released name can only be claimed again by the key that released it", async () => {
  const home = newHome();
  const name = uniqueName("mine");
  await deploy(["--no-copy", "-n", name, folder({ "index.html": "first" })], { home });
  assert.equal((await runCli(["rm", name], { home })).code, 0);

  const stranger = await runCli(["--no-copy", "-n", name, folder({ "index.html": "theirs" })]);
  assert.equal(stranger.code, 1);
  assert.match(stranger.stderr, /site: that name is taken; pick another/);

  const again = await deploy(["--no-copy", "-n", name, folder({ "index.html": "second" })], { home });
  assert.equal((await visit(again.url)).text, "second");
});
