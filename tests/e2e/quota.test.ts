import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { apiKeyOf, baseUrl, folder, newHome, runCli, upload } from "../helpers/site";

const DEPLOYS_PER_KEY = 1000;
const IN_FLIGHT = 25;

type Listing = { deploys: { id: string }[] };

async function listing(key: string): Promise<Listing> {
  const listed = await fetch(`${baseUrl}/list`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(listed.status, 200);
  return (await listed.json()) as Listing;
}

test("a key holds at most 1000 deploys, lists all of them, and deploys again once one is removed", { timeout: 300_000 }, async () => {
  const home = newHome();
  const key = await apiKeyOf(home);
  for (let start = 0; start < DEPLOYS_PER_KEY; start += IN_FLIGHT) {
    const batch = Array.from({ length: Math.min(IN_FLIGHT, DEPLOYS_PER_KEY - start) }, (_, offset) => upload("/page.html", `<p>${start + offset}</p>`, { authorization: `Bearer ${key}` }));
    for (const reply of await Promise.all(batch)) assert.equal(reply.status, 201, reply.text);
  }

  const full = await listing(key);
  assert.equal(full.deploys.length, DEPLOYS_PER_KEY);
  assert.equal(new Set(full.deploys.map((deploy) => deploy.id)).size, DEPLOYS_PER_KEY);

  const refused = await upload("/page.html", "<p>one too many</p>", { authorization: `Bearer ${key}` });
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.text, "A key can hold 1000 deploys and 5 GB; remove some with site rm <id> first.\n");
  const site = folder({ "index.html": "<h1>over</h1>" });
  const cliRefused = await runCli(["--no-copy", site], { home });
  assert.notEqual(cliRefused.code, 0);
  assert.match(cliRefused.stderr, /site rm <id>/);
  assert.equal((await listing(key)).deploys.length, DEPLOYS_PER_KEY);

  const otherKey = await apiKeyOf(newHome());
  assert.equal((await upload("/page.html", "<p>other key</p>", { authorization: `Bearer ${otherKey}` })).status, 201);
  assert.equal((await upload("/page.html", "<p>no key</p>")).status, 201);

  const removed = await runCli(["rm", full.deploys[0].id], { home });
  assert.equal(removed.code, 0, removed.stderr);
  const deployed = await runCli(["--no-copy", site], { home });
  assert.equal(deployed.code, 0, deployed.stderr);
  assert.equal((await listing(key)).deploys.length, DEPLOYS_PER_KEY);
});
