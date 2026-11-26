import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { baseUrl } from "../helpers/site";

test("browsers get the homepage and curl gets usage text", async () => {
  const page = await fetch(baseUrl, { headers: { Accept: "text/html" } });
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.match(html, /<h1>Put a folder on the web\.<\/h1>/);
  assert.match(html, /<p hidden id="automation">Agents and automation:/);
  assert.match(html, /github\.com\/Stoffbergie\/site\/issues/);
  assert.ok(html.indexOf("site dist -n todo") < html.indexOf("<details>"), "everyday commands come before the hidden details");
  assert.ok(html.indexOf("curl -T page.html") > html.indexOf("<details>"), "the curl API sits inside More options");

  const text = await (await fetch(baseUrl)).text();
  assert.match(text, /^site: static sites, live in one command\.\n\nAgents and automation:/);
  assert.match(text, /site point todo k3m9xq2a/);
});

test("the homepage's icon is served from the apex", async () => {
  const icon = await fetch(`${baseUrl}/favicon.png`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/png");
});
