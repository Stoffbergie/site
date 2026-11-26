import { strict as assert } from "node:assert";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { apiKeyOf, deploy, folder, keyOf, newHome, runCli } from "../helpers/site";

test("the first deploy makes a private key that site key prints", async () => {
  const home = newHome();
  const deployed = await runCli(["--no-copy", folder({ "index.html": "x" })], { home });
  assert.equal(deployed.code, 0, deployed.stderr);
  const key = await keyOf(home);
  assert.match(key, /^site_[a-z0-9]{32}\.[a-z0-9]{32}$/);
  assert.equal(await keyOf(home), key, "the key stays the same");

  const configDir = process.platform === "darwin" ? join(home, "Library/Application Support/site") : join(home, "site");
  assert.equal(statSync(join(configDir, "config.json")).mode & 0o777, 0o600);
});

test("site key will not silently replace a different key", async () => {
  const home = newHome();
  const original = await keyOf(home);
  const other = await keyOf(newHome());

  const refused = await runCli(["key", other], { home });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^site: this machine already has a different key; run site key in a terminal to replace it, or delete .+config\.json first\n$/);
  assert.equal(await keyOf(home), original);

  const same = await runCli(["key", original], { home });
  assert.equal(same.code, 0);
  assert.match(same.stderr, /already saved/);
});

test("site key refuses something that is not a key", async () => {
  const result = await runCli(["key", "hunter2"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /that is not a site key/);
});

test("SITE_KEY overrides the saved key", async () => {
  const shared = await keyOf(newHome());
  const home = newHome();
  const result = await runCli(["key"], { home, env: { SITE_KEY: shared } });
  assert.equal(result.stdout.trim(), shared);
});

test("a key saved by an older site gains its private part and still owns its deploys", async () => {
  const old = newHome();
  const { url } = await deploy(["--no-copy", folder({ "index.html": "x" })], { home: old });
  const olderKey = await apiKeyOf(old);

  const home = newHome();
  const configDir = process.platform === "darwin" ? join(home, "Library/Application Support/site") : join(home, "site");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ key: olderKey }));

  const listed = await runCli(["ls"], { home });
  assert.match(listed.stdout, new RegExp(url));
  const upgraded = await keyOf(home);
  assert.match(upgraded, new RegExp(`^${olderKey}\\.[a-z0-9]{32}$`));
  assert.equal(await keyOf(home), upgraded, "the private part is made once");
});

test("private sites need the whole key, not only the part the server sees", async () => {
  const apiOnly = await apiKeyOf(newHome());
  const result = await runCli(["--no-copy", "-e", folder({ "index.html": "x" })], { env: { SITE_KEY: apiOnly } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^site: private sites need the whole key; set SITE_KEY to everything site key prints, including the part after the dot\n$/);

  const plain = await runCli(["--no-copy", folder({ "index.html": "x" })], { env: { SITE_KEY: ` ${apiOnly}\n` } });
  assert.equal(plain.code, 0, plain.stderr);
});
