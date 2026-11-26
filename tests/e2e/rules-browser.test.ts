import { strict as assert } from "node:assert";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { browserUrl, deploy, folder, newHome, uniqueName } from "../helpers/site";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

async function newPage(): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

async function waitForHeading(page: Page, text: string): Promise<void> {
  await page.locator("h1", { hasText: new RegExp(`^${text}$`) }).waitFor();
}

const site = {
  _redirects: [
    "/old  /new  301",
    "/blog/*  /posts/:splat  302",
    "/app/*  /app/index.html  200",
    "/closed/*  /closed.html  404",
    "/forced  /new  301!",
    "/go/*  //:splat  302",
    "/go/*  /new  302"
  ].join("\n"),
  _headers: [
    "/*",
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Cross-Origin-Embedder-Policy: require-corp",
    "  Content-Security-Policy: script-src 'self'",
    "  X-Frame-Options: DENY",
    "/movies/:title",
    "  X-Movie-Name: :title"
  ].join("\n"),
  "index.html": `<!doctype html><h1>Home</h1><script src="/app.js"></script><script>document.documentElement.dataset.inline = "ran"</script>`,
  "app.js": "document.documentElement.dataset.external = 'ran'; document.documentElement.dataset.isolated = String(self.crossOriginIsolated)",
  "new.html": "<h1>New</h1>",
  "forced.html": "<h1>Forced</h1>",
  "posts/hello.html": "<h1>Hello post</h1>",
  "app/index.html": "<h1>App shell</h1>",
  "closed.html": "<h1>Closed section</h1>",
  "movies/dune.html": "<h1>Dune</h1>"
};

async function checkSite(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/`);
  await waitForHeading(page, "Home");
  await page.locator('html[data-external="ran"]').waitFor({ state: "attached" });
  assert.equal(await page.evaluate("document.documentElement.dataset.isolated"), "true", "COOP and COEP make the page cross-origin isolated");
  assert.equal(await page.evaluate("document.documentElement.dataset.inline"), undefined, "the content security policy blocks inline scripts");

  await page.goto(`${origin}/old`);
  await waitForHeading(page, "New");
  assert.equal(page.url(), `${origin}/new`);

  await page.goto(`${origin}/forced`);
  await waitForHeading(page, "New");

  await page.goto(`${origin}/go//evil.example`);
  await waitForHeading(page, "New");
  assert.equal(page.url(), `${origin}/new`, "a rule that would leave the site gives way to the next one");

  await page.goto(`${origin}/blog/hello?from=feed`);
  await waitForHeading(page, "Hello post");
  assert.equal(page.url(), `${origin}/posts/hello?from=feed`);

  const route = await page.goto(`${origin}/app/settings`);
  assert.equal(route?.status(), 200);
  await waitForHeading(page, "App shell");
  assert.equal(page.url(), `${origin}/app/settings`);

  const closed = await page.goto(`${origin}/closed/old-thing`);
  assert.equal(closed?.status(), 404);
  await waitForHeading(page, "Closed section");

  const fetched = await page.evaluate(async () => {
    const movie = await fetch("/movies/dune");
    const rules = await fetch("/_redirects");
    const headers = await fetch("/_headers");
    return { movie: movie.headers.get("x-movie-name"), frame: movie.headers.get("x-frame-options"), rules: rules.status, headers: headers.status };
  });
  assert.deepEqual(fetched, { movie: "dune", frame: "DENY", rules: 404, headers: 404 });

  const missing = await page.evaluate(async () => {
    const reply = await fetch("/nowhere");
    return { status: reply.status, frame: reply.headers.get("x-frame-options") };
  });
  assert.deepEqual(missing, { status: 404, frame: "DENY" }, "the plain 404 carries matching headers");
}

test("redirects, rewrites and headers take effect in a browser on a public named site", async () => {
  const { url } = await deploy(["--no-copy", "-n", uniqueName("rules"), folder(site)], { home: newHome() });
  const page = await newPage();
  await checkSite(page, new URL(browserUrl(url)).origin);
  await page.context().close();
});

test("redirects, rewrites and headers take effect inside an encrypted site", async () => {
  const { url, run } = await deploy(["--no-copy", "-e", folder(site)]);
  assert.match(run.stderr, /10 files/);
  const origin = new URL(browserUrl(url)).origin;
  const page = await newPage();
  await page.goto(browserUrl(url));
  await waitForHeading(page, "Home");
  await checkSite(page, origin);
  await page.context().close();
});

test("a redirect from an encrypted site to another origin never carries the key in the fragment", async () => {
  const landing = await deploy(["--no-copy", folder({ "index.html": "<h1>Landing</h1>" })]);
  const landingOrigin = new URL(browserUrl(landing.url)).origin;
  const rules = [`/out  ${landingOrigin}/  302`, `/out-with-part  ${landingOrigin}/#top  302`].join("\n");
  const { url } = await deploy(["--no-copy", "-e", folder({ _redirects: rules, "index.html": "<h1>Home</h1>" })]);
  const origin = new URL(browserUrl(url)).origin;
  const key = url.split("#")[1];
  const page = await newPage();
  await page.goto(browserUrl(url));
  await waitForHeading(page, "Home");

  await page.goto(`${origin}/out#${key}`);
  await waitForHeading(page, "Landing");
  assert.equal(new URL(page.url()).origin, landingOrigin);
  assert.ok(!page.url().includes(key), `the landing page does not get the key: ${page.url()}`);
  assert.equal(await page.evaluate("location.hash"), "");

  await page.goto(`${origin}/out-with-part#${key}`);
  await waitForHeading(page, "Landing");
  assert.equal(await page.evaluate("location.hash"), "#top");
  await page.context().close();
});

test("on an encrypted site the destination length limit counts the fragment the service worker adds", async () => {
  const landing = await deploy(["--no-copy", folder({ "index.html": "<h1>Landing</h1>", "404.html": "<h1>Landing</h1>" })]);
  const landingOrigin = new URL(browserUrl(landing.url)).origin;
  const destination = `${landingOrigin}/${Array(8).fill(":splat").join("/")}`;
  const { url } = await deploy(["--no-copy", "-e", folder({ _redirects: `/out/*  ${destination}  302\n/out/*  /new  302\n`, "index.html": "<h1>Home</h1>", "new.html": "<h1>New</h1>" })]);
  const origin = new URL(browserUrl(url)).origin;
  const path = `/out/${"a".repeat(2000)}`;
  const base = `${landingOrigin}/${Array(8).fill("a".repeat(2000)).join("/")}`;
  const query = (total: number): string => `?q=${"b".repeat(total - base.length - 3)}`;
  const page = await newPage();
  await page.goto(browserUrl(url));
  await waitForHeading(page, "Home");

  await page.goto(`${origin}${path}${query(16_383)}`);
  await waitForHeading(page, "Landing");
  assert.equal(page.url(), `${base}${query(16_383)}#`, "a Location of 16,383 characters plus the added # is sent");

  await page.goto(`${origin}${path}${query(16_384)}`);
  await waitForHeading(page, "New");
  assert.equal(new URL(page.url()).pathname, "/new", "one more character and the # passes the limit, so the next rule applies");
  await page.context().close();
});
