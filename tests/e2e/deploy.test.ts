import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { deploy, folder, visit } from "../helpers/site";

const page = `<!doctype html><title>Home</title>${"<p>Static sites, live in one command.</p>".repeat(200)}`;

test("a deployed folder is browsable at its own URL with clean URLs and a 404 page", async () => {
  const root = folder({
    "index.html": page,
    "about.html": "<h1>About</h1>",
    "docs/index.html": "<h1>Docs</h1>",
    "404.html": "<h1>Lost</h1>",
    "style.css": "body{color:red}",
    ".env": "SECRET=1",
    "node_modules/pkg/index.js": "nope"
  });
  const { url, run } = await deploy(["--no-copy", root]);
  assert.match(url, /^https:\/\/[a-z0-9]{8}\.site\.localhost$/);
  assert.match(run.stderr, /5 files/);

  const home = await visit(url, "/");
  assert.equal(home.status, 200);
  assert.equal(home.text, page);
  assert.equal(home.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(home.headers["x-content-type-options"], "nosniff");
  assert.equal(home.headers["access-control-allow-origin"], "*");
  assert.equal(home.headers["cache-control"], "public, max-age=31536000, immutable, no-transform");

  assert.equal((await visit(url, "/about")).text, "<h1>About</h1>");
  assert.equal((await visit(url, "/about.html")).text, "<h1>About</h1>");
  assert.equal((await visit(url, "/docs/")).text, "<h1>Docs</h1>");
  const redirect = await visit(url, "/docs?page=2");
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, "/docs/?page=2");
  assert.equal((await visit(url, "/style.css")).headers["content-type"], "text/css; charset=utf-8");

  const missing = await visit(url, "/nowhere");
  assert.equal(missing.status, 404);
  assert.equal(missing.text, "<h1>Lost</h1>");
  assert.equal((await visit(url, "/.env")).status, 404);
  assert.equal((await visit(url, "/node_modules/pkg/index.js")).status, 404);
});

test("redirects point at the decoded path the lookup used and keep the query string", async () => {
  const { url } = await deploy(["--no-copy", folder({ "index.html": page, "about.html": "<h1>About</h1>", "My Docs/index.html": "<h1>Docs</h1>" })]);
  const cases = [
    ["/about%2F?x=1", "/about?x=1"],
    ["/about/%2F", "/about"],
    ["//about/", "/about"],
    ["/My%20Docs", "/My%20Docs/"],
    ["/About%2F%2F", "/About"],
    ["//My%20Docs?a=b", "/My%20Docs/?a=b"]
  ];
  for (const [path, location] of cases) {
    const redirect = await visit(url, path);
    assert.equal(redirect.status, 308, path);
    assert.equal(redirect.headers.location, location, path);
  }
});

test("text files are stored gzipped and reach gzip and plain clients intact", async () => {
  const { url, run } = await deploy(["--no-copy", folder({ "index.html": page })]);
  const stored = Number(/· ([\d.]+) B/.exec(run.stderr)?.[1]);
  assert.ok(stored > 0 && stored < page.length / 5, `the upload is compressed: ${run.stderr}`);

  const zipped = await visit(url, "/", { headers: { "accept-encoding": "gzip" } });
  assert.equal(zipped.headers.vary, "Accept-Encoding, Origin");
  assert.equal(zipped.text, page);

  const plain = await visit(url, "/", { headers: { "accept-encoding": "identity" } });
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.text, page);
});

test("binary files are served raw with byte ranges, HEAD and ETag revalidation", async () => {
  const bytes = randomBytes(5000);
  const { url } = await deploy(["--no-copy", folder({ "index.html": "<h1>Hi</h1>", "data.bin": bytes, "photo.png": bytes })]);

  const whole = await visit(url, "/data.bin");
  assert.equal(whole.headers["content-type"], "application/octet-stream");
  assert.equal(whole.headers["accept-ranges"], "bytes");
  assert.deepEqual(whole.body, bytes);
  assert.equal((await visit(url, "/photo.png")).headers["content-type"], "image/png");

  const middle = await visit(url, "/data.bin", { headers: { range: "bytes=10-19" } });
  assert.equal(middle.status, 206);
  assert.equal(middle.headers["content-range"], "bytes 10-19/5000");
  assert.deepEqual(middle.body, bytes.subarray(10, 20));

  const tail = await visit(url, "/data.bin", { headers: { range: "bytes=-5" } });
  assert.equal(tail.status, 206);
  assert.deepEqual(tail.body, bytes.subarray(4995));

  assert.equal((await visit(url, "/data.bin", { headers: { range: "bytes=9000-" } })).status, 416);

  const head = await visit(url, "/data.bin", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.byteLength, 0);
  assert.ok(head.headers.etag);

  const revalidated = await visit(url, "/data.bin", { headers: { "if-none-match": `W/${head.headers.etag as string}` } });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.body.byteLength, 0);
});

test("a single file is served at / and under its filename", async () => {
  const root = folder({ "logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'></svg>" });
  const { url } = await deploy(["--no-copy", join(root, "logo.svg")]);
  const home = await visit(url, "/");
  assert.equal(home.headers["content-type"], "image/svg+xml");
  assert.match(home.text, /<svg/);
  assert.match((await visit(url, "/logo.svg")).text, /<svg/);
});

test("loose files land at the root and a lone HTML file becomes the page", async () => {
  const first = folder({ "page.html": "<h1>Page</h1>" });
  const second = folder({ "assets/app.js": "console.log(1)" });
  const { url } = await deploy(["--no-copy", join(first, "page.html"), join(second, "assets/app.js")]);
  assert.equal((await visit(url, "/")).text, "<h1>Page</h1>");
  assert.equal((await visit(url, "/app.js")).text, "console.log(1)");
  assert.equal((await visit(url, "/assets/app.js")).status, 404);
});

test("stdin deploys as index.html", async () => {
  const { url } = await deploy(["--no-copy", "-"], { input: "<h1>Piped</h1>" });
  const home = await visit(url, "/");
  assert.equal(home.text, "<h1>Piped</h1>");
  assert.equal((await visit(url, "/index.html")).headers["content-type"], "text/html; charset=utf-8");
});

test("a folder without index.html shows a file list", async () => {
  const { url } = await deploy(["--no-copy", folder({ "a.html": "a", "b.html": "b", "notes/c.txt": "c" })]);
  const home = await visit(url, "/");
  assert.equal(home.status, 200);
  assert.match(home.text, /<a href="\/a\.html">a\.html<\/a>/);
  assert.match(home.text, /<a href="\/notes\/c\.txt">notes\/c\.txt<\/a>/);
});

test("--spa serves index.html for routes without a file extension", async () => {
  const { url } = await deploy(["--no-copy", "--spa", folder({ "index.html": "<div id=app></div>", "app.js": "boot()" })]);
  const route = await visit(url, "/projects/42");
  assert.equal(route.status, 200);
  assert.equal(route.text, "<div id=app></div>");
  assert.equal((await visit(url, "/missing.js")).status, 404);

  const { url: plain } = await deploy(["--no-copy", folder({ "index.html": "<div id=app></div>" })]);
  assert.equal((await visit(plain, "/projects/42")).status, 404);
});

test("deployed sites are read-only and unknown hosts have no site", async () => {
  const { url } = await deploy(["--no-copy", folder({ "index.html": "hi" })]);
  assert.equal((await visit(url, "/", { method: "POST" })).status, 405);
  assert.equal((await visit("https://zzzz2222.site.localhost", "/")).status, 404);
  assert.equal((await visit("https://nobody-here.site.localhost", "/")).status, 404);
});
