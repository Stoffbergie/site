import { strict as assert } from "node:assert";
import { performance } from "node:perf_hooks";
import { test } from "vite-plus/test";
import { deploy, folder, newHome, uniqueName, upload, visit } from "../helpers/site";

const redirects = `# Moved pages
/old            /new            301
/temporary      /new
/see-other      /new            303
/keep-method    /new            307
/permanent      /new            308
/first          /winner         301
/first          /loser          301
/blog/*         /posts/:splat   301
/news/:year/:slug   /articles/:year/:slug   302
/search         /find?from=search   301
/twitch         https://twitch.tv/somebody  301
/authors/c%C3%A9line   /authors/celine   301
/about          /elsewhere      301
/forced         /new            301!
/app/*          /app/index.html 200
/closed/*       /closed.html    404
/proxy/*        https://example.com/:splat  200
/                /us            302  Country=us
/store  id=:id  /blog/:id       301
/admin/*        /admin/login    401
/self/          /self           301!
nonsense
`;

const files = {
  _redirects: redirects,
  "index.html": "<h1>Home</h1>",
  "new.html": "<h1>New</h1>",
  "about.html": "<h1>About</h1>",
  "forced.html": "<h1>Forced</h1>",
  "app/index.html": "<h1>App shell</h1>",
  "closed.html": "<h1>Closed section</h1>",
  "404.html": "<h1>Lost</h1>"
};

test("_redirects rules redirect, rewrite and show custom 404 pages like Netlify and Cloudflare Pages", async () => {
  const { url, run } = await deploy(["--no-copy", folder(files)]);

  const cases: [string, number, string][] = [
    ["/old", 301, "/new"],
    ["/old/", 301, "/new"],
    ["/old?ref=mail&x=1", 301, "/new?ref=mail&x=1"],
    ["/temporary", 302, "/new"],
    ["/see-other", 303, "/new"],
    ["/keep-method", 307, "/new"],
    ["/permanent", 308, "/new"],
    ["/first", 301, "/winner"],
    ["/blog/2024/hello", 301, "/posts/2024/hello"],
    ["/news/2024/launch", 302, "/articles/2024/launch"],
    ["/search?q=cats", 301, "/find?from=search"],
    ["/twitch", 301, "https://twitch.tv/somebody"],
    ["/authors/c%C3%A9line", 301, "/authors/celine"],
    ["/forced", 301, "/new"]
  ];
  for (const [path, status, location] of cases) {
    const reply = await visit(url, path);
    assert.equal(reply.status, status, `${path} answers ${status}`);
    assert.equal(reply.headers.location, location, `${path} goes to ${location}`);
  }

  const shadowed = await visit(url, "/about");
  assert.equal(shadowed.status, 200, "an existing file wins over a rule that is not forced");
  assert.equal(shadowed.text, "<h1>About</h1>");

  const route = await visit(url, "/app/settings/profile");
  assert.equal(route.status, 200);
  assert.equal(route.text, "<h1>App shell</h1>");
  assert.equal(route.headers["content-type"], "text/html; charset=utf-8");

  const closed = await visit(url, "/closed/anything");
  assert.equal(closed.status, 404);
  assert.equal(closed.text, "<h1>Closed section</h1>");

  assert.equal((await visit(url, "/")).text, "<h1>Home</h1>", "a country condition is not applied");
  assert.equal((await visit(url, "/proxy/thing")).status, 404, "a proxy rule is not applied");
  assert.equal((await visit(url, "/store?id=7")).status, 404, "a query condition rule is not applied");
  assert.equal((await visit(url, "/admin/panel")).status, 404, "an unsupported status is not applied");
  const self = await visit(url, "/self");
  assert.equal(self.status, 404, "a rule that redirects to itself is not applied");

  assert.match(run.stderr, /_redirects line 18: .*proxy/i);
  assert.match(run.stderr, /_redirects line 19: .*Country/);
  assert.match(run.stderr, /_redirects line 20: .*query/i);
  assert.match(run.stderr, /_redirects line 21: .*401/);
  assert.match(run.stderr, /_redirects line 22: .*itself/);
  assert.match(run.stderr, /_redirects line 23: /);
  assert.equal(run.stderr.match(/_redirects line 18/g)?.length, 1, "each ignored line is reported once");

  for (const path of ["/_redirects", "/_redirects/"]) {
    const hidden = await visit(url, path);
    assert.equal(hidden.status, 404);
    assert.doesNotMatch(hidden.text, /twitch/);
  }
});

test("a single-page app's /* /index.html 200 fallback serves the app shell and leaves real files alone", async () => {
  const root = folder({
    _redirects: "/*    /index.html   200\n",
    "index.html": "<div id=app></div>",
    "assets/app.js": "boot()"
  });
  const name = uniqueName("spa-rule");
  const { url } = await deploy(["--no-copy", "-n", name, root], { home: newHome() });
  for (const path of ["/", "/dashboard", "/projects/42/edit", "/missing.js"]) {
    const reply = await visit(url, path);
    assert.equal(reply.status, 200, path);
    assert.equal(reply.text, "<div id=app></div>", path);
  }
  const script = await visit(url, "/assets/app.js");
  assert.equal(script.text, "boot()");
  assert.equal(script.headers["content-type"], "text/javascript; charset=utf-8");
});

const headers = `# Security for every page
/*
  X-Frame-Options: DENY
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Content-Security-Policy: default-src 'self'

# === START AUTOGENERATED SVELTE IMMUTABLE HEADERS ===
/_app/*
  X-Robots-Tag: noindex
  Cache-Control: no-cache
/_app/immutable/*
  ! Cache-Control
  Cache-Control: public, immutable, max-age=31536000
# === END AUTOGENERATED SVELTE IMMUTABLE HEADERS ===

/fonts/*
  Access-Control-Allow-Origin: https://example.com

/*.jpg
  ! Content-Security-Policy

/movies/:title
  X-Movie-Name: You are watching ":title"

/api/*
  X-Robots-Tag: noindex
/api/data
  X-Robots-Tag: nosnippet
  Content-Type: application/vnd.example+json

/open.html
  ! Access-Control-Allow-Origin

/*
  Set-Cookie: tracked=yes; Domain=site.localhost
  X-Content-Type-Options: none
  ETag: "forged"
`;

const headerFiles = {
  _headers: headers,
  "index.html": "<h1>Home</h1>",
  "open.html": "<h1>Open</h1>",
  "_app/immutable/app.js": "start()",
  "_app/version.json": "{}",
  "fonts/body.woff2": "font",
  "photo.jpg": "jpeg",
  "movies/dune.html": "<h1>Dune</h1>",
  "api/data": "{}",
  "404.html": "<h1>Lost</h1>"
};

test("_headers rules add, join, detach and override headers within the host's limits", async () => {
  const home = newHome();
  const root = folder(headerFiles);
  const { url, run } = await deploy(["--no-copy", root], { home });

  const page = await visit(url, "/");
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal(page.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(page.headers["cross-origin-embedder-policy"], "require-corp");
  assert.equal(page.headers["content-security-policy"], "default-src 'self'");
  assert.equal(page.headers["x-content-type-options"], "nosniff", "nosniff stays");
  assert.equal(page.headers["set-cookie"], undefined, "a site cannot set cookies");
  assert.match(page.headers.etag as string, /^"[a-z0-9]{8}-\d+"$/, "the host's ETag stays");
  assert.equal(page.headers["access-control-allow-origin"], "*");

  const immutable = await visit(url, "/_app/immutable/app.js");
  assert.equal(immutable.headers["cache-control"], "public, immutable, max-age=31536000, no-transform");
  assert.equal(immutable.headers["x-robots-tag"], "noindex");
  assert.equal((await visit(url, "/_app/version.json")).headers["cache-control"], "no-cache, no-transform");

  assert.equal((await visit(url, "/fonts/body.woff2")).headers["access-control-allow-origin"], "https://example.com");
  assert.equal((await visit(url, "/open.html")).headers["access-control-allow-origin"], undefined);
  assert.equal((await visit(url, "/open")).headers["access-control-allow-origin"], "*", "rules match the requested path");

  const photo = await visit(url, "/photo.jpg");
  assert.equal(photo.headers["content-security-policy"], undefined);
  assert.equal(photo.headers["x-frame-options"], "DENY");

  assert.equal((await visit(url, "/movies/dune")).headers["x-movie-name"], 'You are watching "dune"');

  const data = await visit(url, "/api/data");
  assert.equal(data.headers["x-robots-tag"], "noindex, nosnippet");
  assert.equal(data.headers["content-type"], "application/vnd.example+json");

  const missing = await visit(url, "/nowhere");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["x-frame-options"], "DENY", "the 404 page gets the headers for its path");

  const revalidated = await visit(url, "/_app/immutable/app.js", { headers: { "if-none-match": immutable.headers.etag as string } });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers["cache-control"], "public, immutable, max-age=31536000, no-transform");

  assert.equal((await visit(url, "/_headers")).status, 404);
  assert.match(run.stderr, /_headers line \d+: .*Set-Cookie/);
  assert.match(run.stderr, /_headers line \d+: .*X-Content-Type-Options/);
  assert.match(run.stderr, /_headers line \d+: .*ETag/);

  const name = uniqueName("headers");
  const named = await deploy(["--no-copy", "-n", name, root], { home });
  const namedAsset = await visit(named.url, "/_app/immutable/app.js");
  assert.equal(namedAsset.headers["cache-control"], "no-cache, no-transform", "a named host still revalidates so a redeploy shows on the next load");
  assert.equal(namedAsset.headers["x-robots-tag"], "noindex");
});

test("redirect rules take priority over header rules", async () => {
  const { url } = await deploy(["--no-copy", folder({ _redirects: "/go /index.html 302\n", _headers: "/go\n  X-Seen: yes\n", "index.html": "home" })]);
  const reply = await visit(url, "/go");
  assert.equal(reply.status, 302);
  assert.equal(reply.headers["x-seen"], undefined);
});

test("a site with only a _redirects file redirects every path", async () => {
  const { url } = await deploy(["--no-copy", folder({ _redirects: "/*  https://example.com/:splat  301!\n" })]);
  const reply = await visit(url, "/docs/start?lang=en");
  assert.equal(reply.status, 301);
  assert.equal(reply.headers.location, "https://example.com/docs/start?lang=en");
  assert.equal((await visit(url, "/")).headers.location, "https://example.com/");
});

test("rule files deployed without rules, by curl or older CLIs, are never served", async () => {
  const single = await upload("/_redirects", "/a /b 301\n", { accept: "application/json" });
  assert.equal(single.status, 201);
  const singleUrl = deployedUrl(single.text);
  assert.equal((await visit(singleUrl, "/_redirects")).status, 404);
  assert.equal((await visit(singleUrl, "/")).status, 404);

  const index = JSON.stringify({
    spa: false,
    files: [
      { path: "_headers", offset: 0, length: 3, type: "application/octet-stream", gzip: false },
      { path: "index.html", offset: 3, length: 2, type: "text/html; charset=utf-8", gzip: false }
    ]
  });
  const old = await upload("/", pack(index, "/a\nhi"), { accept: "application/json" }, "POST");
  assert.equal(old.status, 201, old.text);
  const oldUrl = deployedUrl(old.text);
  assert.equal((await visit(oldUrl, "/")).text, "hi");
  assert.equal((await visit(oldUrl, "/_headers")).status, 404);
});

test("the Worker refuses malformed rules in a pack and ignores fields it does not know", async () => {
  const file = [{ path: "index.html", offset: 0, length: 2, type: "text/html; charset=utf-8", gzip: false }];
  const bad = await upload("/", pack(JSON.stringify({ spa: false, files: file, rules: { redirects: [{ from: "old", to: "/new", status: 301, force: false }] } }), "hi"), {}, "POST");
  assert.equal(bad.status, 400);
  assert.match(bad.text, /rule/i);

  const future = await upload("/", pack(JSON.stringify({ spa: false, files: file, rules: { redirects: [], headers: [], later: true }, later: 1 }), "hi"), { accept: "application/json" }, "POST");
  assert.equal(future.status, 201, future.text);
  assert.equal((await visit(deployedUrl(future.text), "/")).text, "hi");
});

test("rules are bounded and a hostile path cannot slow matching down", async () => {
  const lines: string[] = [];
  for (let number = 0; number < 10_050; number += 1) lines.push(`/page-${number} /new 301`);
  for (let number = 0; number < 1_005; number += 1) lines.unshift(`/w${number}/:a/:b/:c/* /new 301`);
  const { url, run } = await deploy(["--no-copy", folder({ _redirects: lines.join("\n"), "index.html": "home", "new.html": "new" })]);
  assert.match(run.stderr, /_redirects: .*10,000/);
  assert.match(run.stderr, /_redirects: .*1,000/);
  assert.equal((await visit(url, "/page-8999")).headers.location, "/new");
  assert.equal((await visit(url, "/page-9000")).status, 404);
  assert.equal((await visit(url, "/w1004/a/b/c/d")).headers.location, "/new");
  assert.equal((await visit(url, "/w0/a/b/c/d")).status, 404);

  const hostile = `/${"w1004/".repeat(1500)}${"a".repeat(4000)}`;
  const started = performance.now();
  const reply = await visit(url, hostile);
  assert.ok(reply.status === 301 || reply.status === 404);
  assert.ok(performance.now() - started < 2000, "matching stays fast");
});

test("a site cannot send headers that reach sibling sites or the API through the shared domain", async () => {
  const blocked = ["Clear-Site-Data", "Origin-Agent-Cluster", "NEL", "Report-To", "Sec-Session-Registration", "Secure-Session-Registration"];
  const lines = [
    "/*",
    '  Clear-Site-Data: "cookies", "storage"',
    "  Origin-Agent-Cluster: ?0",
    '  NEL: {"report_to":"default","max_age":86400,"include_subdomains":true}',
    '  Report-To: {"group":"default","max_age":86400,"endpoints":[{"url":"https://example.com/r"}],"include_subdomains":true}',
    '  Sec-Session-Registration: (ES256);path="/s"',
    '  Secure-Session-Registration: (ES256);path="/s"',
    "  X-Allowed: yes"
  ];
  const { url, run } = await deploy(["--no-copy", folder({ _headers: lines.join("\n"), "index.html": "home" })]);
  const reply = await visit(url, "/");
  assert.equal(reply.headers["x-allowed"], "yes");
  for (const name of blocked) {
    assert.equal(reply.headers[name.toLowerCase()], undefined, `${name} is never sent`);
    assert.match(run.stderr, new RegExp(`_headers line \\d+: ignored, ${name} is set by site`));
  }

  const file = [{ path: "index.html", offset: 0, length: 4, type: "text/html; charset=utf-8", gzip: false }];
  const rules = { headers: [{ path: "/*", headers: blocked.map((name) => ({ name, value: "?0" })) }] };
  const direct = await upload("/", pack(JSON.stringify({ spa: false, files: file, rules }), "home"), { accept: "application/json" }, "POST");
  assert.equal(direct.status, 201, direct.text);
  const directReply = await visit(deployedUrl(direct.text), "/");
  for (const name of blocked) assert.equal(directReply.headers[name.toLowerCase()], undefined, `${name} from a hand-built pack is never sent`);
});

test("a splat cannot turn a path destination into another origin", async () => {
  const rules = "/go/*  /:splat  302\n/show/*  /:splat  200\n/hop/*  //:splat  302\n/peek/*  //:splat  200\n";
  const { url } = await deploy(["--no-copy", folder({ _redirects: rules, "index.html": "home" })]);
  const collapsed = await visit(url, "/go//evil.example/x");
  assert.equal(collapsed.headers.location, "/evil.example/x", "a doubled slash collapses before matching, so the splat stays a path on this site");
  const escaped = await visit(url, "/hop/evil.example/x");
  assert.equal(escaped.headers.location, undefined, "the rule does not match when its destination leaves the site");
  assert.equal(escaped.status, 404);
  assert.equal((await visit(url, "/go/index.html")).headers.location, "/index.html");
  assert.equal((await visit(url, "/show//evil.example/x")).status, 404);
  assert.equal((await visit(url, "/peek/evil.example/x")).status, 404);
});

test("on named hosts only a standalone no-cache or no-store keeps a site's Cache-Control", async () => {
  const lines = [
    "/quoted.js",
    '  Cache-Control: public, max-age=600, x-note="no-cache, no-store"',
    "/extension.js",
    "  Cache-Control: public, max-age=600, x-no-cache",
    "/qualified.js",
    '  Cache-Control: max-age=600, no-cache="Set-Cookie"',
    "/strict.js",
    "  Cache-Control: NO-CACHE, max-age=0",
    "/transform.js",
    "  Cache-Control: no-store, x-no-transform"
  ];
  const files = { _headers: lines.join("\n"), "quoted.js": "1", "extension.js": "2", "qualified.js": "3", "strict.js": "4", "transform.js": "5" };
  const { url } = await deploy(["--no-copy", "-n", uniqueName("cache"), folder(files)], { home: newHome() });
  for (const path of ["/quoted.js", "/extension.js", "/qualified.js"]) {
    assert.equal((await visit(url, path)).headers["cache-control"], "no-cache, no-transform", `${path} keeps the host's revalidation`);
  }
  assert.equal((await visit(url, "/strict.js")).headers["cache-control"], "NO-CACHE, max-age=0, no-transform");
  assert.equal((await visit(url, "/transform.js")).headers["cache-control"], "no-store, x-no-transform, no-transform");
});

test("the Worker refuses patterns that are not well-formed text or have more than one splat", async () => {
  const file = [{ path: "index.html", offset: 0, length: 2, type: "text/html; charset=utf-8", gzip: false }];
  const indexWith = (rules: string) => `{"spa":false,"files":${JSON.stringify(file)},"rules":${rules}}`;
  const refused = [
    '{"redirects":[{"from":"/a\\ud800","to":"/b","status":301,"force":false}]}',
    '{"redirects":[{"from":"/:x\\udc00","to":"/:x","status":301,"force":false}]}',
    '{"headers":[{"path":"/\\udfff*","headers":[{"name":"X-A","value":":splat"}]}]}',
    '{"redirects":[{"from":"/a/*/b/*","to":"/:splat","status":301,"force":false}]}',
    '{"headers":[{"path":"/**","headers":[{"name":"X-A","value":"1"}]}]}'
  ];
  for (const rules of refused) {
    const reply = await upload("/", pack(indexWith(rules), "hi"), {}, "POST");
    assert.equal(reply.status, 400, rules);
    assert.match(reply.text, /rule/i);
  }
  const fine = await upload("/", pack(indexWith('{"redirects":[{"from":"/caf\\u00e9/*","to":"/:splat","status":301,"force":false}]}'), "hi"), { accept: "application/json" }, "POST");
  assert.equal(fine.status, 201, fine.text);
  assert.equal((await visit(deployedUrl(fine.text), "/caf%C3%A9/%F0%9F%98%80")).headers.location, "/%F0%9F%98%80");
});

test("expanded header values, Cache-Control included, stay within the 32 KB budget", async () => {
  const file = [{ path: "index.html", offset: 0, length: 2, type: "text/html; charset=utf-8", gzip: false }];
  const rules = {
    headers: [
      { path: "/*", headers: [{ name: "Cache-Control", value: `max-age=60, x-${":splat".repeat(300)}` }] },
      { path: "/*", headers: [{ name: "X-Small", value: "kept" }] }
    ]
  };
  const reply = await upload("/", pack(JSON.stringify({ spa: true, files: file, rules }), "hi"), { accept: "application/json" }, "POST");
  assert.equal(reply.status, 201, reply.text);
  const url = deployedUrl(reply.text);
  const long = await visit(url, `/${"a".repeat(200)}`);
  assert.equal(long.status, 200);
  assert.equal(long.headers["cache-control"], "public, max-age=31536000, immutable, no-transform", "a Cache-Control past the budget is left out");
  assert.equal(long.headers["x-small"], "kept");
  const short = await visit(url, "/ab");
  assert.equal(short.headers["cache-control"], `max-age=60, x-${"ab".repeat(300)}, no-transform`);
});

test("redirects that come back to the requested address or loop between rules are not followed", async () => {
  const name = uniqueName("loops");
  const lines = [
    "/ping  /pong  301",
    "/pong  /ping  301",
    "/dot  /./dot  301",
    "/same  /same?view=all  301",
    `/absolute  http://${name}.site.localhost/absolute  301`,
    "/one  /two  302",
    "/two  /two.html  302"
  ];
  const { url, run } = await deploy(["--no-copy", "-n", name, folder({ _redirects: lines.join("\n"), "index.html": "home", "same.html": "same", "two.html": "two" })], { home: newHome() });
  assert.match(run.stderr, /_redirects line 1: .*loop with line 2/);
  assert.match(run.stderr, /_redirects line 2: .*loop with line 1/);
  assert.match(run.stderr, /_redirects line 3: .*itself/);
  assert.doesNotMatch(run.stderr, /_redirects line [4-7]:/);
  assert.equal((await visit(url, "/ping")).status, 404);
  assert.equal((await visit(url, "/absolute")).status, 404, "a same-origin absolute URL back to the request is not followed");
  assert.equal((await visit(url, "/one")).headers.location, "/two");

  const file = [{ path: "index.html", offset: 0, length: 2, type: "text/html; charset=utf-8", gzip: false }];
  const redirects = [
    { from: "/dot", to: "/./dot", status: 301, force: true },
    { from: "/up", to: "/x/../up/", status: 301, force: true },
    { from: "/encoded", to: "/%65ncoded", status: 301, force: true }
  ];
  const direct = await upload("/", pack(JSON.stringify({ spa: false, files: file, rules: { redirects } }), "hi"), { accept: "application/json" }, "POST");
  assert.equal(direct.status, 201, direct.text);
  for (const path of ["/dot", "/up", "/encoded"]) assert.equal((await visit(deployedUrl(direct.text), path)).status, 404, path);
});

test("the root of a deploy is decided by the visible files, not the rule files", async () => {
  const shadow = await deploy(["--no-copy", folder({ _redirects: "/  /elsewhere  302\n", "notes.txt": "notes" })]);
  assert.equal((await visit(shadow.url, "/")).headers.location, "/elsewhere", "a lone file that is not index.html does not shadow a rule for /");

  const lone = await deploy(["--no-copy", folder({ _headers: "/*\n  X-Seen: yes\n", "report.pdf": "%PDF-1.4" })]);
  const root = await visit(lone.url, "/");
  assert.equal(root.status, 200);
  assert.equal(root.headers["content-type"], "application/pdf");
  assert.equal(root.text, "%PDF-1.4");
  assert.match(root.headers.etag as string, /-1"$/, "entry numbers still count the rule files");
  assert.equal(root.headers["x-seen"], "yes");
});

test("a 404 rewrite never answers with a listing", async () => {
  const { url } = await deploy(["--no-copy", folder({ _redirects: "/gone/*  /  404\n", "a.html": "a", "b.html": "b" })]);
  const reply = await visit(url, "/gone/thing");
  assert.equal(reply.status, 404);
  assert.equal(reply.text, "Not found\n");
});

test("redirects compare the query and find it only before the fragment", async () => {
  const lines = ["/page  /page?view=all  301!", "/frag  /new#part?x  301"];
  const { url, run } = await deploy(["--no-copy", folder({ _redirects: lines.join("\n"), "page.html": "page", "new.html": "new" })]);
  assert.doesNotMatch(run.stderr, /itself/);
  assert.equal((await visit(url, "/page")).headers.location, "/page?view=all");
  assert.equal((await visit(url, "/page?view=all")).text, "page");
  assert.equal((await visit(url, "/frag?q=1")).headers.location, "/new?q=1#part?x");
});

test("an oversized _headers path line ends the block above it", async () => {
  const lines = ["/first", "  X-First: yes", `/${"x".repeat(2100)}`, "  X-Leaked: yes", "/second", "  X-Second: yes"];
  const { url, run } = await deploy(["--no-copy", folder({ _headers: lines.join("\n"), "first.html": "1", "second.html": "2" })]);
  assert.match(run.stderr, /_headers line 3: .*2000 characters/);
  const first = await visit(url, "/first");
  assert.equal(first.headers["x-first"], "yes");
  assert.equal(first.headers["x-leaked"], undefined);
  assert.equal((await visit(url, "/second")).headers["x-second"], "yes");
});

test("rules that would push the index past 2 MB are cut to fit and reported", async () => {
  const lines: string[] = [];
  for (let number = 0; number < 10_000; number += 1) lines.push(`/page-${number}  /${"d".repeat(240)}-${number}  301`);
  const { url, run } = await deploy(["--no-copy", folder({ _redirects: lines.join("\n"), "index.html": "home" })]);
  const kept = /_redirects: only the first ([\d,]+) rules fit in a deploy's 2 MB index/.exec(run.stderr);
  assert.ok(kept, run.stderr);
  const count = Number(kept[1].replace(/,/g, ""));
  assert.ok(count > 5_000 && count < 10_000, `${count} rules kept`);
  assert.equal((await visit(url, "/page-0")).headers.location, `/${"d".repeat(240)}-0`);
  assert.equal((await visit(url, `/page-${count - 1}`)).status, 301);
  assert.equal((await visit(url, `/page-${count}`)).status, 404);
});

test("the plain 404 carries the headers that match its path", async () => {
  const { url } = await deploy(["--no-copy", folder({ _headers: "/*\n  X-Frame-Options: DENY\n", "index.html": "home" })]);
  const missing = await visit(url, "/nowhere");
  assert.equal(missing.status, 404);
  assert.equal(missing.text, "Not found\n");
  assert.equal(missing.headers["x-frame-options"], "DENY");
});

test("an encrypted pack cannot carry rules in its clear index, and the bootstrap page leaves rule checks to the service worker", async () => {
  const salt = "A".repeat(22);
  const files = [
    { offset: 0, length: 20 },
    { offset: 20, length: 20 }
  ];
  const withRules = { encrypted: { linkSalt: salt, contentSalt: salt }, files, rules: { redirects: [] } };
  const refused = await upload("/", pack(JSON.stringify(withRules), "x".repeat(40)), {}, "POST");
  assert.equal(refused.status, 400);
  assert.match(refused.text, /sealed index/);
  const without = { encrypted: { linkSalt: salt, contentSalt: salt }, files };
  assert.equal((await upload("/", pack(JSON.stringify(without), "x".repeat(40)), {}, "POST")).status, 201);

  const { url } = await deploy(["--no-copy", "-e", folder({ _redirects: "/a /b 301\n", "index.html": "home" })]);
  const host = url.split("#")[0];
  const boot = await visit(host, "/__site/boot.js");
  const serviceWorker = await visit(host, "/__site/sw.js");
  assert.match(serviceWorker.text, /redirect rules must be/);
  assert.doesNotMatch(boot.text, /redirect rules must be/);
});

test("a rule whose destination would leave the site is skipped and the next matching rule applies", async () => {
  const lines = ["/go/*  //:splat  302", "/go/*  /fallback  302", "/to/*  //:splat  302", "/to//evil.example  /exact  301", "/keep/*  /:splat  302"];
  const { url } = await deploy(["--no-copy", folder({ _redirects: lines.join("\n"), "index.html": "home" })]);
  assert.equal((await visit(url, "/go//evil.example/x")).headers.location, "/fallback");
  assert.equal((await visit(url, "/keep/index.html")).headers.location, "/index.html");
  assert.equal((await visit(url, "/to//evil.example")).headers.location, "/exact");
});

test("a Cache-Control with an unterminated quote is ignored and the host's policy stays", async () => {
  const files = { _headers: '/open.js\n  Cache-Control: no-cache, x-note="unterminated\n', "open.js": "1" };
  const root = folder(files);
  const home = newHome();
  const { url } = await deploy(["--no-copy", "-n", uniqueName("quote"), root], { home });
  assert.equal((await visit(url, "/open.js")).headers["cache-control"], "no-cache, no-transform");
  const byId = await deploy(["--no-copy", root], { home });
  assert.equal((await visit(byId.url, "/open.js")).headers["cache-control"], "public, max-age=31536000, immutable, no-transform");
});

test("the destination length limit counts the query a redirect keeps", async () => {
  const { url } = await deploy(["--no-copy", folder({ _redirects: `/long/*  /${":splat/".repeat(7)}  301\n`, "index.html": "home" })]);
  const path = `/long/${"a".repeat(2000)}`;
  const kept = await visit(url, path);
  assert.equal(kept.status, 301);
  assert.equal((kept.headers.location as string).length, 14_008);
  const over = await visit(url, `${path}?q=${"b".repeat(3000)}`);
  assert.equal(over.status, 404, "a Location past 16,384 characters is never sent");
  assert.equal(over.headers.location, undefined);
});

test("a 404 rewrite on a single-page app ends in its own page, 404.html or the plain 404, never the app shell", async () => {
  const rules = "/gone/*  /missing-page  404\n/closed/*  /closed  404\n";
  const { url } = await deploy(["--no-copy", "--spa", folder({ _redirects: rules, "index.html": "<h1>App</h1>", "closed.html": "<h1>Closed</h1>", "404.html": "<h1>Lost</h1>" })]);
  const gone = await visit(url, "/gone/thing");
  assert.equal(gone.status, 404);
  assert.equal(gone.text, "<h1>Lost</h1>");
  const closed = await visit(url, "/closed/thing");
  assert.equal(closed.status, 404);
  assert.equal(closed.text, "<h1>Closed</h1>");
  assert.equal((await visit(url, "/dashboard")).text, "<h1>App</h1>", "other paths still get the app shell");

  const plain = await deploy(["--no-copy", "--spa", folder({ _redirects: rules, "index.html": "<h1>App</h1>" })]);
  const missing = await visit(plain.url, "/gone/thing");
  assert.equal(missing.status, 404);
  assert.equal(missing.text, "Not found\n");
});

test("a site's cross-origin headers are honoured one by one and never combine into a pair browsers reject", async () => {
  const lines = [
    "/explicit.html",
    "  Access-Control-Allow-Origin: https://allowed.example",
    "/no-credentials.html",
    "  ! Access-Control-Allow-Credentials",
    "/any.html",
    "  Access-Control-Allow-Origin: *",
    "/fixed.html",
    "  Access-Control-Allow-Origin: https://allowed.example",
    "  Access-Control-Allow-Credentials: true"
  ];
  const files = { _headers: lines.join("\n"), "explicit.html": "1", "no-credentials.html": "2", "any.html": "3", "fixed.html": "4" };
  const { url } = await deploy(["--no-copy", folder(files)]);
  const fromOrigin = (origin: string) => ({ headers: { origin } });

  const allowed = await visit(url, "/explicit.html", fromOrigin("https://allowed.example"));
  assert.equal(allowed.headers["access-control-allow-origin"], "https://allowed.example");
  assert.equal(allowed.headers["access-control-allow-credentials"], "true", "the origin the site allows can send credentials");
  assert.match(String(allowed.headers.vary), /Origin/);
  const other = await visit(url, "/explicit.html", fromOrigin("https://other.example"));
  assert.equal(other.headers["access-control-allow-origin"], "https://allowed.example");
  assert.equal(other.headers["access-control-allow-credentials"], undefined);

  const withoutCredentials = await visit(url, "/no-credentials.html", fromOrigin("https://other.example"));
  assert.equal(withoutCredentials.headers["access-control-allow-origin"], "https://other.example");
  assert.equal(withoutCredentials.headers["access-control-allow-credentials"], undefined, "a removed header stays removed");
  assert.match(String(withoutCredentials.headers.vary), /Origin/);

  const any = await visit(url, "/any.html", fromOrigin("https://other.example"));
  assert.equal(any.headers["access-control-allow-origin"], "*");
  assert.equal(any.headers["access-control-allow-credentials"], undefined, "the host never pairs * with credentials");

  const fixed = await visit(url, "/fixed.html", fromOrigin("https://other.example"));
  assert.equal(fixed.headers["access-control-allow-origin"], "https://allowed.example");
  assert.equal(fixed.headers["access-control-allow-credentials"], "true");
  assert.doesNotMatch(String(fixed.headers.vary), /Origin/, "nothing depends on the Origin when the site decides both");
});

test("a destination too long once %-encoded is reported and skipped, and the other rules still deploy", async () => {
  const lines = [`/long  /${"é".repeat(700)}  301`, "/old  /new  301"];
  const { url, run } = await deploy(["--no-copy", folder({ _redirects: lines.join("\n"), "index.html": "home", "new.html": "new" })]);
  assert.match(run.stderr, /_redirects line 1: ignored, .*2000 characters/);
  assert.equal((await visit(url, "/old")).headers.location, "/new");
  assert.equal((await visit(url, "/long")).status, 404);
});

function deployedUrl(reply: string): string {
  return (JSON.parse(reply) as { url: string }).url;
}

function pack(index: string, data: string): Buffer {
  const json = Buffer.from(index);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.byteLength);
  return Buffer.concat([Buffer.from("SITEPACK1\n"), length, json, Buffer.from(data)]);
}

test("what the host appends to a site's Cache-Control counts toward the header budget before the site's other headers", async () => {
  const lines = ["/*"];
  for (let number = 0; number < 16; number += 1) lines.push(`  X-Pad-${String(number).padStart(2, "0")}: ${"p".repeat(1980)}`);
  const cacheControl = `max-age=60, community=${"c".repeat(878)}`;
  lines.push(`  Cache-Control: ${cacheControl}`, "  Access-Control-Allow-Origin: https://site.example");
  const { url } = await deploy(["--no-copy", folder({ _headers: lines.join("\n"), "index.html": "home" })]);
  const reply = await visit(url, "/", { headers: { Origin: "https://reader.example" } });
  assert.equal(reply.headers["x-pad-15"], "p".repeat(1980));
  assert.equal(reply.headers["cache-control"], `${cacheControl}, no-transform`);
  assert.equal(reply.headers["access-control-allow-origin"], "https://reader.example", "the site's header that no longer fits is left to the host");
  assert.equal(reply.headers["access-control-allow-credentials"], "true");
  assert.match(reply.headers.vary as string, /\bOrigin\b/, "the host's origin-dependent answer says so in Vary");
});

test("rules and the navigation rules compose without loops on a public site", async () => {
  const rules = [
    "/about  /new  301",
    "/contact  /new  301",
    "/guide  /new  301",
    "/docs  /new  301",
    "/legacy  /new  301",
    "/team  /new  301!",
    "/blog/*  /new  302",
    "/myrepo/*  /new  301",
    "/help  /about  200",
    "/manual  /docs  200",
    "/g  /GUIDE  200",
    "/gone/*  /nowhere  200",
    "/chain  /blog/x  200",
    "/hidden  /missing  404",
    "/s/*  /s/:splat/  301!",
    "/f/*  /f/:splat  301!",
    "/c/*  /C/:splat  301!",
    "/old-page  /new  301"
  ];
  const files = {
    _redirects: rules.join("\n"),
    _headers: "/*\n  X-Rule: all\n/deep/:name\n  X-Name: :name\n",
    "index.html": "home",
    "about.html": "about",
    "contact.htm": "contact",
    "Guide.html": "guide",
    "docs/index.html": "docs",
    "legacy/index.htm": "legacy",
    "team.html": "team",
    "new.html": "new",
    "s/page.html": "s-page",
    "f/sub/index.html": "f-sub",
    "C/x/index.html": "c-x",
    "200.html": "shell",
    "assets/app.js": "app()"
  };
  const { url } = await deploy(["--no-copy", folder(files)]);

  for (const [path, text] of [
    ["/about", "about"],
    ["/contact", "contact"],
    ["/guide", "guide"],
    ["/docs/", "docs"],
    ["/legacy/", "legacy"],
    ["/TEAM", "team"]
  ]) {
    const reply = await visit(url, path);
    assert.equal(reply.status, 200, path);
    assert.equal(reply.text, text, `${path}: an unforced rule gives way to a page the navigation rules find`);
  }
  assert.equal((await visit(url, "/docs")).headers.location, "/docs/", "a folder counts as existing");
  assert.equal((await visit(url, "/team")).headers.location, "/new", "a forced rule wins over an existing page");
  assert.equal((await visit(url, "/blog/post")).headers.location, "/new", "an explicit rule wins over 200.html");
  assert.equal((await visit(url, "/myrepo/assets/app.js")).headers.location, "/new", "an explicit rule wins over a base-path asset");
  assert.equal((await visit(url, "/other/assets/app.js")).text, "app()");
  assert.equal((await visit(url, "/route")).text, "shell");

  for (const [path, text] of [
    ["/help", "about"],
    ["/manual", "docs"],
    ["/g", "guide"]
  ]) {
    const reply = await visit(url, path);
    assert.equal(reply.status, 200, path);
    assert.equal(reply.text, text, `${path}: a rewrite destination is found with the navigation rules`);
    assert.equal(reply.headers.location, undefined);
  }
  for (const path of ["/gone/x", "/chain", "/hidden"]) {
    const reply = await visit(url, path);
    assert.equal(reply.status, 404, `${path}: a rewrite to nothing is a real 404, not 200.html or another rule`);
    assert.equal(reply.text, "Not found\n");
  }

  const hops = async (start: string): Promise<{ path: string; text: string; count: number }> => {
    let path = start;
    for (let count = 0; count < 10; count += 1) {
      const reply = await visit(url, path);
      if (reply.headers.location === undefined) return { path, text: reply.text, count };
      path = new URL(reply.headers.location as string, `http://host${path}`).pathname;
    }
    throw new Error(`${start} kept redirecting`);
  };
  assert.deepEqual(await hops("/s/page"), { path: "/s/page", text: "s-page", count: 0 }, "a rule adding a slash never fights the rule removing it");
  assert.deepEqual(await hops("/s/page/"), { path: "/s/page", text: "s-page", count: 1 });
  assert.deepEqual(await hops("/f/sub/"), { path: "/f/sub/", text: "f-sub", count: 0 }, "a rule removing a slash never fights the folder redirect");
  assert.deepEqual(await hops("/f/sub"), { path: "/f/sub/", text: "f-sub", count: 1 });
  assert.deepEqual(await hops("/c/x/"), { path: "/C/x/", text: "c-x", count: 2 }, "rule paths match letter case exactly, so case folding never loops with them");

  for (const path of ["//old-page", "/old%2Dpage", "/x/%2e%2e/old-page", "/old-page//"]) {
    assert.equal((await visit(url, path)).headers.location, "/new", `${path} matches the rule for the normalised path`);
  }
  const deep = await visit(url, "/deep//dune");
  assert.equal(deep.text, "shell");
  assert.equal(deep.headers["x-name"], "dune", "header rules match the normalised path");

  for (const path of ["/route", "/GUIDE", "/contact", "/other/assets/app.js", "/help", "/nope.js", "/gone/x"]) {
    assert.equal((await visit(url, path)).headers["x-rule"], "all", `${path} carries the site's headers`);
  }
  for (const path of ["/_redirects", "/_Redirects", "/_HEADERS"]) {
    const reply = await visit(url, path);
    assert.equal(reply.status, 200, `${path} is a route for 200.html, never a rule file`);
    assert.equal(reply.text, "shell");
  }
});

test("deploy-time loop detection counts the pages the navigation rules find", async () => {
  const lines = ["/a  /b  301", "/b  /a  301", "/c  /d  301", "/d  /c  301"];
  const { url, run } = await deploy(["--no-copy", folder({ _redirects: lines.join("\n"), "B.htm": "b", "index.html": "home" })]);
  assert.equal((await visit(url, "/a")).headers.location, "/b");
  assert.equal((await visit(url, "/b")).text, "b", "a page in another letter case and extension stops the rule, so there is no loop");
  assert.doesNotMatch(run.stderr, /_redirects line [12]: /);
  assert.match(run.stderr, /_redirects line 3: ignored, it redirects in a loop with line 4/);
});
