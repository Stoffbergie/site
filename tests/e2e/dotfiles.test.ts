import { strict as assert } from "node:assert";
import { join } from "node:path";
import { chromium } from "playwright";
import { test } from "vite-plus/test";
import { browserUrl, deploy, folder, hostOf, runCli, uniqueName, visit } from "../helpers/site";

const appSiteAssociation = JSON.stringify({ applinks: { details: [{ appIDs: ["ABCDE12345.com.example.app"], components: [{ "/": "/open/*" }] }] } });
const assetLinks = JSON.stringify([{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "com.example.app" } }]);
const securityTxt = "Contact: https://github.com/example/site/issues\nExpires: 2027-12-31T23:59:59Z\n";

const wellKnown = {
  ".well-known/security.txt": securityTxt,
  ".well-known/apple-app-site-association": appSiteAssociation,
  ".well-known/assetlinks.json": assetLinks,
  ".well-known/acme-challenge/LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0": "LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0.9jg46WB3rR_AHD-EBXdN7cBkH1WOu0tA3M9fm21mqTI",
  ".well-known/webfinger": JSON.stringify({ subject: "acct:me@example.com", links: [] }),
  ".well-known/host-meta": `<?xml version="1.0"?><XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"></XRD>`,
  ".well-known/openid-configuration": JSON.stringify({ issuer: "https://example.com" }),
  ".well-known/mta-sts.txt": "version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: 86400\n",
  ".well-known/change-password.html": "<h1>Change your password</h1>",
  ".well-known/oauth-authorization-server/issuer1": JSON.stringify({ issuer: "https://example.com/issuer1" }),
  "tenant/.well-known/openid-configuration": JSON.stringify({ issuer: "https://example.com/tenant" })
};

const secretsAndJunk = {
  ".env": "STRIPE_KEY=sk_live_123",
  ".env.local": "TOKEN=abc",
  ".env.production": "TOKEN=prod",
  ".npmrc": "//registry.npmjs.org/:_authToken=npm_secret",
  ".htpasswd": "admin:$apr1$secret",
  ".git/config": "[remote]",
  ".git/HEAD": "ref: refs/heads/main",
  ".svn/entries": "12",
  ".DS_Store": "junk",
  "._index.html": "apple double",
  ".vscode/settings.json": "{}",
  ".idea/workspace.xml": "<project/>",
  ".index.html.swp": "swap",
  ".well-known/.DS_Store": "junk",
  "blog/.env": "NESTED=1",
  "node_modules/pkg/index.js": "nope"
};

const servedTypes: Record<string, string> = {
  "/.well-known/security.txt": "text/plain; charset=utf-8",
  "/.well-known/apple-app-site-association": "application/json; charset=utf-8",
  "/.well-known/assetlinks.json": "application/json; charset=utf-8",
  "/.well-known/acme-challenge/LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0": "text/plain; charset=utf-8",
  "/.well-known/webfinger": "application/jrd+json; charset=utf-8",
  "/.well-known/host-meta": "application/xrd+xml; charset=utf-8",
  "/.well-known/openid-configuration": "application/json; charset=utf-8",
  "/.well-known/mta-sts.txt": "text/plain; charset=utf-8",
  "/.well-known/oauth-authorization-server/issuer1": "application/json; charset=utf-8",
  "/tenant/.well-known/openid-configuration": "application/json; charset=utf-8"
};

const neverServed = [
  "/.env",
  "/.env.local",
  "/.env.production",
  "/.npmrc",
  "/.htpasswd",
  "/.git/config",
  "/.git/HEAD",
  "/.svn/entries",
  "/.DS_Store",
  "/._index.html",
  "/.vscode/settings.json",
  "/.idea/workspace.xml",
  "/.index.html.swp",
  "/.well-known/.DS_Store",
  "/blog/.env"
];

function site(): string {
  return folder({ "index.html": "<h1>Home</h1>", "blog/index.html": "<h1>Blog</h1>", ...wellKnown, ...secretsAndJunk });
}

async function checkPublic(url: string): Promise<void> {
  for (const [path, type] of Object.entries(servedTypes)) {
    const reply = await visit(url, path);
    assert.equal(reply.status, 200, `${path} is served`);
    assert.equal(reply.headers["content-type"], type, `${path} has its type`);
  }
  assert.equal((await visit(url, "/.well-known/security.txt")).text, securityTxt);
  assert.equal((await visit(url, "/.well-known/apple-app-site-association")).text, appSiteAssociation);
  assert.equal((await visit(url, "/.well-known/change-password")).text, "<h1>Change your password</h1>");
  for (const path of neverServed) assert.equal((await visit(url, path)).status, 404, `${path} is not served`);
}

test(".well-known deploys with the right types while secrets and junk stay behind, on id and named hosts", async () => {
  const name = uniqueName("dots");
  const { url, run } = await deploy(["--no-copy", "-n", name, site()]);
  assert.match(run.stderr, /13 files/);
  const leftOut = run.stderr.split("\n").find((line) => line.startsWith("Left out")) ?? "";
  assert.match(leftOut, /\.env/);
  assert.match(leftOut, /names starting with a dot stay private, except \.well-known/);
  for (const quiet of [".git", ".svn", ".DS_Store", "._index.html", "node_modules"]) assert.equal(leftOut.includes(quiet), false, `${quiet} is skipped without a word`);

  await checkPublic(url);
  const idHost = /^(https:\/\/[a-z0-9]{8}\.site\.localhost)/m.exec(run.stderr)?.[1] ?? "";
  await checkPublic(idHost);
});

test("build output with only junk dot-names deploys without a note", async () => {
  const { run } = await deploy(["--no-copy", folder({ "index.html": "hi", ".DS_Store": "junk", ".nojekyll": "", ".gitkeep": "", ".git/HEAD": "ref" })]);
  assert.match(run.stderr, /1 file/);
  assert.doesNotMatch(run.stderr, /Left out/);
});

test("a folder inside a dot-folder deploys, like .vitepress/dist and .output/public", async () => {
  const root = folder({ ".vitepress/dist/index.html": "<h1>Docs</h1>", ".output/public/index.html": "<h1>Nuxt</h1>" });
  const vitepress = await deploy(["--no-copy", join(root, ".vitepress/dist")]);
  assert.equal((await visit(vitepress.url, "/")).text, "<h1>Docs</h1>");
  const nuxt = await deploy(["--no-copy", join(root, ".output/public")]);
  assert.equal((await visit(nuxt.url, "/")).text, "<h1>Nuxt</h1>");
});

test("loose dot-files follow the same rule", async () => {
  const root = folder({ "index.html": "<h1>Loose</h1>", ".env": "SECRET=1", ".DS_Store": "junk" });
  const { url, run } = await deploy(["--no-copy", join(root, "index.html"), join(root, ".env"), join(root, ".DS_Store")]);
  assert.match(run.stderr, /1 file/);
  assert.match(run.stderr, /^Left out \.env: names starting with a dot stay private, except \.well-known$/m);
  assert.equal((await visit(url, "/.env")).status, 404);

  const alone = await runCli(["--no-copy", join(root, ".env")]);
  assert.notEqual(alone.code, 0);
  assert.match(alone.stderr, /nothing to deploy/);
});

test("an encrypted site keeps the same rule and serves .well-known in the browser", async () => {
  const { url, run } = await deploy(["--no-copy", "-e", site()]);
  assert.match(run.stderr, /13 files/);
  assert.match(run.stderr, /^Left out .*\.env/m);
  assert.match(run.stderr, /\.well-known files on a private site open only in a browser with the link/);
  const meta = JSON.parse((await visit(hostOf(url), "/__site/meta")).text) as { entries: number[] };
  assert.equal(meta.entries.length, 14);

  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(browserUrl(url));
    await page.waitForFunction(`document.querySelector("h1")?.textContent === "Home"`);
    const replies = await page.evaluate(
      async (paths) => {
        const results: Record<string, { status: number; type: string | null; text: string }> = {};
        for (const path of paths) {
          const response = await fetch(path);
          results[path] = { status: response.status, type: response.headers.get("content-type"), text: await response.text() };
        }
        return results;
      },
      [...Object.keys(servedTypes), ...neverServed]
    );
    for (const [path, type] of Object.entries(servedTypes)) {
      assert.equal(replies[path].status, 200, `${path} is served`);
      assert.equal(replies[path].type, type, `${path} has its type`);
    }
    assert.equal(replies["/.well-known/apple-app-site-association"].text, appSiteAssociation);
    for (const path of neverServed) assert.equal(replies[path].status, 404, `${path} is not served`);
  } finally {
    await browser.close();
  }
});
