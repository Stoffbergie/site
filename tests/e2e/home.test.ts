import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { test } from "vite-plus/test";
import { baseUrl, deploy, folder, visit } from "../helpers/site";

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

test("the apex sends security headers on pages, text and assets, and the homepage renders under its policy", async () => {
  const replies = [
    await fetch(baseUrl, { headers: { Accept: "text/html" } }),
    await fetch(baseUrl),
    await fetch(`${baseUrl}/favicon.png`),
    await fetch(`${baseUrl}/missing`, { headers: { Accept: "text/html" } }),
    await fetch(`${baseUrl}/names/missing`, { method: "DELETE", headers: { Authorization: "Bearer <script>" } })
  ];
  for (const reply of replies) {
    assert.equal(reply.headers.get("x-content-type-options"), "nosniff", reply.url);
    assert.equal(reply.headers.get("x-frame-options"), "DENY", reply.url);
    assert.match(reply.headers.get("content-security-policy") ?? "", /default-src 'none'.*frame-ancestors 'none'/, reply.url);
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    await page.addInitScript(`document.addEventListener("securitypolicyviolation", (event) => console.log("Content Security Policy violation: " + event.violatedDirective))`);
    await page.goto(baseUrl);
    assert.equal(await page.locator("h1").textContent(), "Put a folder on the web.");
    const font = await page.evaluate<string>("getComputedStyle(document.documentElement).fontFamily");
    assert.match(font, /monospace/, "the inline stylesheet applies");
    const iconWidth = await page.evaluate<number>(`(async () => {
      const image = new Image();
      image.src = document.querySelector('link[rel="icon"]').href;
      await image.decode();
      return image.naturalWidth;
    })()`);
    assert.ok(iconWidth > 0, "same-origin icons load");
    assert.deepEqual(violations, []);
  } finally {
    await browser.close();
  }
});

test("deployed sites keep deciding their own security headers", async () => {
  const { url } = await deploy(["--no-copy", folder({ "index.html": "<h1>Mine</h1>" })]);
  const reply = await visit(url);
  assert.equal(reply.text, "<h1>Mine</h1>");
  assert.equal(reply.headers["content-security-policy"], undefined);
  assert.equal(reply.headers["x-frame-options"], undefined);
});
