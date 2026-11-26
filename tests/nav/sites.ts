import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Files = Record<string, string | Buffer>;

const fixtures = join(import.meta.dirname, "fixtures");
const fixture = (name: string): Buffer => readFileSync(join(fixtures, name));

const dot = fixture("dot.png");
const dot2 = fixture("dot2.png");
const wasm = Buffer.from("0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b", "hex");

export function page(name: string, body = "", head = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="page" content="${name}"><title>${name}</title>${head}</head><body><h1>${name}</h1>${body}</body></html>`;
}

const tall = `<div style="height:3000px"></div>`;

const flat: Files = {
  "index.html": page(
    "home",
    `<a id="rel-about" href="about.html">about</a>
<a id="dot-about" href="./about.html">about</a>
<a id="root-about" href="/about">about</a>
<a id="clean" href="about">about</a>
<a id="htm" href="contact.htm">contact</a>
<a id="folder-slash" href="docs/">docs</a>
<a id="folder-noslash" href="docs">docs</a>
<a id="folder-index" href="docs/index.html">docs</a>
<a id="query" href="about?ref=home#team">about</a>
<a id="space" href="My%20File.html">space</a>
<a id="space-raw" href="My File.html">space</a>
<a id="plus" href="c++.html">plus</a>
<a id="cafe" href="café.html">cafe</a>
<a id="resume" href="Résumé.html">resume</a>
<a id="base" href="base/page.html">base</a>
<a id="blank" href="about.html" target="_blank">about</a>
<a id="download" href="files/report.txt" download>report</a>
<a id="anchor" href="#far">far</a>
<img id="caseimg" src="Logo.PNG">
<form id="search" action="search.html" method="get"><input name="q" value="hello world"><button>go</button></form>
<form id="search-clean" action="/search" method="get"><input name="q" value="clean"><button>go</button></form>
${tall}<section id="far">far</section>${tall}`
  ),
  "about.html": page("about", `<a id="up" href="index.html">home</a><a id="guide" href="docs/guide.html">guide</a>${tall}<section id="team">team</section>${tall}`),
  "contact.htm": page("contact"),
  "search.html": page("search", `<script>document.body.dataset.q = new URLSearchParams(location.search).get("q") ?? ""</script>`),
  "docs/index.html": page("docs", `<a id="guide" href="guide.html">guide</a><a id="up" href="../about.html">about</a><a id="deep" href="deep/page.html">deep</a>`),
  "docs/guide.html": page("guide", `<a id="back" href="../index.html">home</a><a id="sib" href="index.html">docs</a>${tall}<section id="install">install</section>${tall}`),
  "docs/deep/page.html": page("deep", `<a id="up2" href="../../about.html">about</a>`),
  "docs-old/index.htm": page("oldindex"),
  "My File.html": page("space"),
  "c++.html": page("plus"),
  ["café.html".normalize("NFC")]: page("cafe"),
  ["Résumé.html".normalize("NFD")]: page("resume"),
  "base/page.html": page("base", `<a id="guide" href="guide.html">guide</a>`, `<base href="/docs/">`),
  "old.html": page("old", "", `<meta http-equiv="refresh" content="0; url=about.html">`),
  "logo.png": dot,
  "files/report.txt": "report body\n",
  "404.html": page("notfound")
};

const kitchenScript = `
const results = {};
window.results = results;
fetch("data/info.json?v=2").then((r) => r.json()).then((data) => { results.json = data.ok; });
const worker = new Worker("js/worker.js");
worker.onmessage = (event) => { results.worker = event.data; };
const moduleWorker = new Worker("js/module-worker.mjs", { type: "module" });
moduleWorker.onmessage = (event) => { results.moduleWorker = event.data; };
WebAssembly.instantiateStreaming(fetch("/wasm/add.wasm")).then(({ instance }) => { results.wasm = instance.exports.add(2, 3); }, (error) => { results.wasm = String(error); });
`;

const kitchen: Files = {
  "index.html": page(
    "kitchen",
    `<p id="styled" class="bg">styled</p><span id="font" style="font-family:NavTest,monospace;font-size:16px">AAAA</span><span id="fallback" style="font-family:monospace;font-size:16px">AAAA</span>
<img id="srcset" src="img/dot.png" srcset="img/dot.png 1x, img/dot2.png 2x">
<video id="video" preload="auto" muted><source src="media/clip.webm" type="video/webm"><source src="media/clip.mp4" type="video/mp4"></video>
<audio id="audio" preload="auto" src="media/tone.wav"></audio>
<iframe id="frame" src="frame.html"></iframe>
<script src="js/classic.js"></script>
<script type="module" src="js/main.mjs"></script>
<script>${kitchenScript}</script>`,
    `<link rel="stylesheet" href="css/main.css"><link rel="manifest" href="/site.webmanifest"><link rel="icon" href="/favicon.ico">`
  ),
  "frame.html": page("frame", `<a id="next" href="frame2.html">next</a>`),
  "frame2.html": page("frame2"),
  "css/main.css": `@import "base.css";\n@font-face{font-family:NavTest;src:url(../fonts/wide.woff) format("woff")}\n.bg{background-image:url(../img/dot.png)}\n`,
  "css/base.css": `#styled{color:rgb(0, 128, 0)}\n`,
  "fonts/wide.woff": fixture("wide.woff"),
  "img/dot.png": dot,
  "img/dot2.png": dot2,
  "media/clip.webm": fixture("clip.webm"),
  "media/clip.mp4": fixture("clip.mp4"),
  "media/tone.wav": fixture("tone.wav"),
  "js/classic.js": `window.classicRan = true;\n//# sourceMappingURL=classic.js.map\n`,
  "js/classic.js.map": JSON.stringify({ version: 3, sources: ["classic.ts"], names: [], mappings: "AAAA" }),
  "js/main.mjs": `import { value } from "./dep.js";\nwindow.moduleValue = value;\nimport("./lazy.js").then((lazy) => { window.lazyValue = lazy.default; });\n`,
  "js/dep.js": `export const value = "static";\n`,
  "js/lazy.js": `export default "dynamic";\n`,
  "js/worker.js": `importScripts("helper.js");\npostMessage(helperValue);\n`,
  "js/helper.js": `var helperValue = "worker ok";\n`,
  "js/module-worker.mjs": `import { value } from "./dep.js";\npostMessage(value);\n`,
  "data/info.json": `{"ok":true}`,
  "wasm/add.wasm": wasm,
  "site.webmanifest": JSON.stringify({ name: "Kitchen", icons: [{ src: "/favicon.ico", sizes: "16x16" }] }),
  "favicon.ico": dot
};

const ownServiceWorker: Files = {
  "index.html": page(
    "ownsw-home",
    `<a id="about" href="about.html">about</a><script>window.registration = navigator.serviceWorker.register("/sw.js").then(() => "registered", (error) => "failed: " + error.name)</script>`
  ),
  "about.html": page("ownsw-about"),
  "sw.js": `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname === "/sw-hello") event.respondWith(new Response("hello from the site's worker"));
  else event.respondWith(fetch(event.request));
});`
};

const historyRouter = `
const routes = [[/^\\/$/, "spa-home"], [/^\\/users\\/([^/]+)$/, "spa-user"]];
function render() {
  let name = "spa-notfound";
  let param = "";
  for (const [pattern, routeName] of routes) {
    const match = pattern.exec(location.pathname);
    if (match) { name = routeName; param = match[1] ?? ""; break; }
  }
  document.body.dataset.param = decodeURIComponent(param);
  document.getElementById("app").innerHTML = '<a id="to-user" data-link href="/users/3">user</a> <a id="to-home" data-link href="/">home</a>';
  document.querySelector("meta[name=page]").content = name;
}
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-link]");
  if (!link) return;
  event.preventDefault();
  history.pushState(null, "", link.getAttribute("href"));
  render();
});
addEventListener("popstate", render);
render();
`;

const viteSpa: Files = {
  "index.html": page(
    "spa-loading",
    `<div id="app"></div>`,
    `<script type="module" crossorigin src="/assets/index-B7xQ2k.js"></script><link rel="stylesheet" crossorigin href="/assets/index-D4f1.css"><link rel="icon" href="/vite.svg">`
  ),
  "assets/index-B7xQ2k.js": historyRouter,
  "assets/index-D4f1.css": "body{margin:0}",
  "vite.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>`
};

const spaWithNotFound: Files = {
  "index.html": page("spa-loading", `<div id="app"></div>`, `<script type="module" src="/assets/app.js"></script>`),
  "assets/app.js": historyRouter,
  "404.html": page("real-404")
};

const hashRouter = `
function render() {
  const match = /^#\\/users\\/([^/]+)$/.exec(location.hash);
  let name = "spa-notfound";
  if (location.hash === "" || location.hash === "#/") name = "spa-home";
  if (match) name = "spa-user";
  document.body.dataset.param = match ? match[1] : "";
  document.querySelector("meta[name=page]").content = name;
}
addEventListener("hashchange", render);
render();
`;

const hashSpa: Files = {
  "index.html": page("spa-loading", `<a id="to-user" href="#/users/3">user</a>`, `<script defer src="app.js"></script>`),
  "app.js": hashRouter
};

const nextExport: Files = {
  "index.html": page(
    "next-home",
    `<a id="about" href="/about">about</a><a id="blog" href="/blog">blog</a>`,
    `<link rel="stylesheet" href="/_next/static/css/app-1a2b.css"><script src="/_next/static/chunks/main-3c4d.js" defer></script>`
  ),
  "about.html": page("next-about"),
  "about.txt": "1:about-rsc-payload\n",
  "blog.html": page("next-blog"),
  "blog/first-post.html": page("next-post"),
  "404.html": page("next-404"),
  "_next/static/chunks/main-3c4d.js": "window.nextChunk = true;",
  "_next/static/css/app-1a2b.css": "h1{color:rgb(0, 0, 255)}"
};

const nextSlash: Files = {
  "index.html": page("nexts-home"),
  "about/index.html": page("nexts-about", `<a id="home" href="../">home</a>`),
  "blog/first-post/index.html": page("nexts-post"),
  "404.html": page("nexts-404")
};

const astro: Files = {
  "index.html": page("astro-home", "", `<script type="module" src="/_astro/hoisted.Bx9a.js"></script>`),
  "about/index.html": page("astro-about", "", `<script type="module" src="/_astro/hoisted.Bx9a.js"></script>`),
  "_astro/hoisted.Bx9a.js": "window.astroRan = true;",
  "404.html": page("astro-404")
};

const docusaurusRouter = `
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (!link) return;
  event.preventDefault();
  history.pushState(null, "", link.getAttribute("href"));
  document.querySelector("meta[name=page]").content = link.dataset.route;
});
`;

const docusaurus: Files = {
  "index.html": page("docu-home", `<a id="intro" data-route="docu-intro" href="/docs/intro">intro</a>`, `<script src="/assets/js/main.4f2a.js" defer></script>`),
  "docs/intro/index.html": page("docu-intro", `<a id="next" data-route="docu-next" href="/docs/next">next</a>`, `<script src="/assets/js/main.4f2a.js" defer></script>`),
  "docs/next/index.html": page("docu-next", "", `<script src="/assets/js/main.4f2a.js" defer></script>`),
  "assets/js/main.4f2a.js": docusaurusRouter,
  "404.html": page("docu-404")
};

const hugoCss = "h1{color:rgb(128, 0, 128)}";
const hugoIntegrity = `sha256-${createHash("sha256").update(hugoCss).digest("base64")}`;
const hugoHead = `<link rel="stylesheet" href="/css/main.min.5e1f.css" integrity="${hugoIntegrity}" crossorigin="anonymous">`;

const hugo: Files = {
  "index.html": page("hugo-home", `<a id="post" href="/posts/my-post/">post</a>`, hugoHead),
  "posts/my-post/index.html": page("hugo-post", "", hugoHead),
  "posts/index.html": page("hugo-posts"),
  "index.xml": `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>`,
  "css/main.min.5e1f.css": hugoCss,
  "404.html": page("hugo-404")
};

const jekyll: Files = {
  "index.html": page("jekyll-home"),
  "about.html": page("jekyll-about"),
  "2026/11/26/welcome-to-jekyll.html": page("jekyll-post"),
  "assets/css/style.css": "h1{color:rgb(1, 2, 3)}",
  "feed.xml": `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`,
  "404.html": page("jekyll-404")
};

const mkdocsHead = (prefix: string): string => `<link rel="stylesheet" href="${prefix}css/theme.css">`;

const mkdocs: Files = {
  "index.html": page("mk-home", `<a id="about" href="about/">about</a>`, mkdocsHead("")),
  "about/index.html": page(
    "mk-about",
    `<a id="home" href="../">home</a><script>fetch("../search/search_index.json").then((r) => r.json()).then((d) => { document.body.dataset.search = d.docs.length })</script>`,
    mkdocsHead("../")
  ),
  "css/theme.css": "h1{color:rgb(10, 20, 30)}",
  "search/search_index.json": `{"docs":[{"location":""}]}`,
  "sitemap.xml.gz": Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  "404.html": page("mk-404")
};

const eleventy: Files = {
  "index.html": page("11ty-home"),
  "blog/post-1/index.html": page("11ty-post"),
  "404.html": page("11ty-404")
};

const surge: Files = {
  "index.html": page("surge-home"),
  "200.html": page("surge-app"),
  "about.html": page("surge-about")
};

const ghPagesSpa: Files = {
  "index.html": page(
    "gh-loading",
    "",
    `<script>(function (l) { if (l.search[1] === "/") { var decoded = l.search.slice(1).split("&").map(function (s) { return s.replace(/~and~/g, "&"); }).join("?"); window.history.replaceState(null, null, l.pathname.slice(0, -1) + decoded + l.hash); } })(window.location);
document.addEventListener("DOMContentLoaded", function () { document.querySelector("meta[name=page]").content = location.pathname === "/" ? "gh-home" : "gh-route"; });</script>`
  ),
  "404.html": `<!doctype html><html><head><meta charset="utf-8"><script>var l = window.location; l.replace(l.protocol + "//" + l.host + "/?/" + l.pathname.slice(1).replace(/&/g, "~and~") + (l.search ? "&" + l.search.slice(1).replace(/&/g, "~and~") : "") + l.hash);</script></head><body></body></html>`
};

const basePath: Files = {
  "index.html": page("base-app", "", `<script type="module" crossorigin src="/myrepo/assets/index-Q1w2.js"></script><link rel="icon" href="/myrepo/favicon.svg">`),
  "assets/index-Q1w2.js": "document.body.dataset.ran = 'yes';",
  "favicon.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>`
};

const plain: Files = {
  "index.html": page("plain-home", "", `<script src="script.js"></script>`),
  "about.html": page("plain-about"),
  "script.js": "window.plain = true;"
};

const landing: Files = {
  "index.html": page("landing", `<img src="hero.png">`, `<link rel="stylesheet" href="style.css">`),
  "style.css": "body{margin:0}",
  "hero.png": dot
};

const noReferrer: Files = {
  "index.html": page("noref-home", `<a id="about" href="about.html">about</a><a id="plain-about" rel="noreferrer" href="about.html">about</a>`, `<meta name="referrer" content="no-referrer">`),
  "about.html": page("noref-about", `<a id="home" href="index.html">home</a>`, `<meta name="referrer" content="no-referrer">`)
};

const viteRelative: Files = {
  "index.html": page("rel-app", `<div id="app"></div>`, `<script type="module" crossorigin src="./assets/index-R3l4.js"></script>`),
  "assets/index-R3l4.js": "document.body.dataset.ran = location.pathname;"
};

const caseFolder: Files = {
  "Docs/readme.html": page("case-readme"),
  "assets/app.js": "window.app = true;",
  "404.html": page("case-404")
};

const xhtmlPage: Files = {
  "index.html": page("xhtml-home", "", `<script src="app.js"></script>`),
  "guide.xhtml": `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><meta name="page" content="xhtml-guide"/><title>guide</title></head><body><h1>guide</h1></body></html>`,
  "app.js": "window.app = true;"
};

const rulesNav: Files = {
  _redirects: [
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
    "/s/*  /s/:splat/  301!",
    "/f/*  /f/:splat  301!",
    "/c/*  /C/:splat  301!",
    "/old-page  /new  301"
  ].join("\n"),
  _headers: ["/*", "  X-Rule: all", "/deep/:name", "  X-Name: :name"].join("\n"),
  "index.html": page("rn-home"),
  "about.html": page("rn-about"),
  "contact.htm": page("rn-contact"),
  "Guide.html": page("rn-guide"),
  "docs/index.html": page("rn-docs"),
  "legacy/index.htm": page("rn-legacy"),
  "team.html": page("rn-team"),
  "new.html": page("rn-new"),
  "s/page.html": page("rn-s-page"),
  "f/sub/index.html": page("rn-f-sub"),
  "C/x/index.html": page("rn-c-x"),
  "200.html": page("rn-shell"),
  "assets/app.js": "window.app = true;"
};

const rulesSpa: Files = {
  _redirects: ["/old  /dashboard  301", "/missing/*  /nothing  404"].join("\n"),
  _headers: ["/*", "  X-Rule: spa"].join("\n"),
  "index.html": page("rs-app", "", `<script src="/app.js"></script>`),
  "app.js": "window.app = true;"
};

export const sites = {
  rulesNav,
  rulesSpa,
  caseFolder,
  xhtmlPage,
  noReferrer,
  viteRelative,
  flat,
  kitchen,
  ownServiceWorker,
  viteSpa,
  spaWithNotFound,
  hashSpa,
  nextExport,
  nextSlash,
  astro,
  docusaurus,
  hugo,
  jekyll,
  mkdocs,
  eleventy,
  surge,
  ghPagesSpa,
  basePath,
  plain,
  landing
};

export type SiteName = keyof typeof sites;
