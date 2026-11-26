import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page, type Response } from "playwright";
import { afterAll, beforeAll, describe, test } from "vite-plus/test";
import { browserUrl, deploy, folder, newHome, uniqueName } from "../helpers/site";
import { page as htmlPage, sites, type Files, type SiteName } from "./sites";

type Mode = "public" | "private";
type HostKind = "id" | "named";
type BrowserName = "chromium" | "firefox" | "webkit";
type Deployed = { origin: string; key: string | null; name: string | null };
type Expected = { path?: string; search?: string; hash?: string };

type T = {
  mode: Mode;
  browserName: BrowserName;
  page: Page;
  context: BrowserContext;
  site: Deployed;
  at(path: string): string;
  open(path?: string, anchor?: string): Promise<Response | null>;
  goto(path: string): Promise<Response | null>;
  expect(name: string, url?: Expected): Promise<void>;
  click(selector: string): Promise<void>;
  eval<R>(script: string): Promise<R>;
  fresh(files: Files): Promise<Deployed>;
  redeploy(deployed: Deployed, files: Files): Promise<void>;
  waitFor(script: string, timeout?: number): Promise<void>;
};

type Case = {
  name: string;
  site: SiteName;
  modes?: Mode[];
  hosts?: HostKind[];
  browsers?: BrowserName[];
  run(t: T): Promise<void>;
};

const browserTypes: Record<BrowserName, BrowserType> = { chromium, firefox, webkit };
const browserNames = (process.env.NAV_BROWSERS ?? "chromium,firefox,webkit").split(",") as BrowserName[];
const modes: Mode[] = ["public", "private"];
const homes: Record<Mode, string> = { public: newHome(), private: newHome() };
const deploys = new Map<string, Promise<Deployed>>();
const browsers = new Map<BrowserName, Browser>();

beforeAll(async () => {
  for (const name of browserNames) browsers.set(name, await browserTypes[name].launch());
});

afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
});

async function deployFiles(files: Files, mode: Mode, host: HostKind, name: string | null = null): Promise<Deployed> {
  const args = ["--no-copy"];
  if (mode === "private") args.push("-e");
  let siteName = name;
  if (host === "named" && siteName === null) siteName = uniqueName("nav");
  if (siteName !== null) args.push("-n", siteName);
  const { url } = await deploy([...args, folder(files)], { home: homes[mode] });
  const link = new URL(browserUrl(url));
  const key = link.hash.slice(1);
  return { origin: link.origin, key: key === "" ? null : key, name: siteName };
}

function deployed(site: SiteName, mode: Mode, host: HostKind): Promise<Deployed> {
  const id = `${site}|${mode}|${host}`;
  let pending = deploys.get(id);
  if (pending === undefined) {
    pending = deployFiles(sites[site], mode, host);
    deploys.set(id, pending);
  }
  return pending;
}

function makeT(mode: Mode, browserName: BrowserName, context: BrowserContext, page: Page, site: Deployed): T {
  const t: T = {
    mode,
    browserName,
    page,
    context,
    site,
    at: (path) => `${site.origin}${path}`,
    open: (path = "/", anchor) => {
      let fragment = "";
      if (mode === "private") fragment = `#${site.key}`;
      if (anchor !== undefined) fragment += `#${anchor}`;
      return t.page.goto(`${site.origin}${path}${fragment}`);
    },
    goto: async (path) => {
      const documents: Response[] = [];
      const page = t.page;
      const collect = (response: Response): void => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) documents.push(response);
      };
      page.on("response", collect);
      try {
        await page.goto(`${site.origin}${path}`);
        await page.waitForFunction(`document.readyState === "complete" && document.querySelector("[data-state]") === null`, undefined, { timeout: 8000 }).catch(() => undefined);
      } finally {
        page.off("response", collect);
      }
      return documents.at(-1) ?? null;
    },
    expect: async (name, url = {}) => {
      try {
        await t.page.waitForFunction(`document.querySelector('meta[name="page"]')?.content === ${JSON.stringify(name)}`, undefined, { timeout: 8000 });
      } catch {
        const seen = await t.page.evaluate(`document.querySelector('meta[name="page"]')?.content ?? document.body?.innerText?.slice(0, 80)`).catch(() => "?");
        throw new Error(`expected page ${name}, saw ${String(seen)} at ${t.page.url()}`);
      }
      const current = new URL(t.page.url());
      if (url.path !== undefined) assert.equal(decodeURI(current.pathname), url.path, "path");
      if (url.search !== undefined) assert.equal(current.search, url.search, "query");
      if (url.hash !== undefined) assert.equal(current.hash, url.hash, "hash");
    },
    click: async (selector) => {
      await t.page.click(selector);
    },
    eval: (script) => t.page.evaluate(script),
    fresh: (files) => deployFiles(files, mode, site.name === null ? "id" : "named"),
    redeploy: async (target, files) => {
      await deployFiles(files, mode, "named", target.name);
    },
    waitFor: async (script, timeout = 8000) => {
      await t.page.waitForFunction(script, undefined, { timeout });
    }
  };
  return t;
}

const cases: Case[] = [];
const add = (site: SiteName, name: string, run: Case["run"], options: Partial<Case> = {}): void => {
  cases.push({ site, name, run, ...options });
};

const warm = async (t: T, path = "/", name = "home"): Promise<void> => {
  await t.open(path);
  await t.expect(name);
};

add("flat", "relative link", async (t) => {
  await warm(t);
  await t.click("#rel-about");
  await t.expect("about", { path: "/about.html" });
});
add("flat", "dot-relative link", async (t) => {
  await warm(t);
  await t.click("#dot-about");
  await t.expect("about", { path: "/about.html" });
});
add("flat", "root-relative link without .html", async (t) => {
  await warm(t);
  await t.click("#root-about");
  await t.expect("about", { path: "/about" });
});
add("flat", "relative link without .html", async (t) => {
  await warm(t);
  await t.click("#clean");
  await t.expect("about", { path: "/about" });
});
add("flat", ".htm link", async (t) => {
  await warm(t);
  await t.click("#htm");
  await t.expect("contact", { path: "/contact.htm" });
});
add("flat", ".htm page without extension", async (t) => {
  await warm(t);
  await t.goto("/contact");
  await t.expect("contact");
});
add("flat", "folder link with trailing slash", async (t) => {
  await warm(t);
  await t.click("#folder-slash");
  await t.expect("docs", { path: "/docs/" });
});
add("flat", "folder link without trailing slash keeps relative links working", async (t) => {
  await warm(t);
  await t.click("#folder-noslash");
  await t.expect("docs", { path: "/docs/" });
  await t.click("#guide");
  await t.expect("guide", { path: "/docs/guide.html" });
});
add("flat", "explicit index.html", async (t) => {
  await warm(t);
  await t.click("#folder-index");
  await t.expect("docs", { path: "/docs/index.html" });
  await t.click("#guide");
  await t.expect("guide", { path: "/docs/guide.html" });
});
add("flat", "query string and fragment on a clean URL", async (t) => {
  await warm(t);
  await t.click("#query");
  await t.expect("about", { path: "/about", search: "?ref=home", hash: "#team" });
});
add("flat", "folder redirect keeps query string and fragment", async (t) => {
  await warm(t);
  await t.goto("/docs?x=1#h");
  await t.expect("docs", { path: "/docs/", search: "?x=1", hash: "#h" });
});
add("flat", "percent-encoded space", async (t) => {
  await warm(t);
  await t.click("#space");
  await t.expect("space");
});
add("flat", "raw space in href", async (t) => {
  await warm(t);
  await t.click("#space-raw");
  await t.expect("space");
});
add("flat", "plus signs, raw and encoded", async (t) => {
  await warm(t);
  await t.click("#plus");
  await t.expect("plus", { path: "/c++.html" });
  await t.goto("/c%2B%2B.html");
  await t.expect("plus");
});
add("flat", "non-ASCII file name", async (t) => {
  await warm(t);
  await t.click("#cafe");
  await t.expect("cafe");
});
add("flat", "file name stored decomposed (NFD), linked composed", async (t) => {
  await warm(t);
  await t.click("#resume");
  await t.expect("resume");
});
add("flat", "letter case differs from the page on disk", async (t) => {
  await warm(t);
  await t.goto("/ABOUT");
  await t.expect("about");
  await t.goto("/About.html");
  await t.expect("about");
});
add("flat", "letter case differs from the folder and file on disk", async (t) => {
  await warm(t);
  await t.goto("/DOCS/Guide.html");
  await t.expect("guide");
});
add("flat", "letter case differs for an image", async (t) => {
  await warm(t);
  await t.waitFor(`document.getElementById("caseimg").complete && document.getElementById("caseimg").naturalWidth === 4`);
});
add("flat", "doubled slash inside the path", async (t) => {
  await warm(t);
  await t.goto("/docs//guide.html");
  await t.expect("guide");
});
add("flat", "doubled leading slash", async (t) => {
  await warm(t);
  await t.goto("//about.html");
  await t.expect("about");
});
add("flat", "<base href> resolves links", async (t) => {
  await warm(t);
  await t.click("#base");
  await t.expect("base");
  await t.click("#guide");
  await t.expect("guide", { path: "/docs/guide.html" });
});
add("flat", "parent-relative links", async (t) => {
  await warm(t, "/docs/guide.html", "guide");
  await t.click("#back");
  await t.expect("home");
  await t.goto("/docs/deep/page.html");
  await t.expect("deep");
  await t.click("#up2");
  await t.expect("about", { path: "/about.html" });
});
add("flat", "page URL with a trailing slash", async (t) => {
  await warm(t);
  await t.goto("/about/");
  await t.expect("about");
  await t.click("#guide");
  await t.expect("guide", { path: "/docs/guide.html" });
});
add("flat", "page URL with a trailing slash keeps the query string", async (t) => {
  await warm(t);
  await t.goto("/about/?ref=x");
  await t.expect("about", { path: "/about", search: "?ref=x" });
});
add("flat", "page URL with an encoded trailing slash redirects to the page", async (t) => {
  await warm(t);
  await t.goto("/about%2F?x=1");
  await t.expect("about", { path: "/about", search: "?x=1" });
  await t.goto("/about/%2F");
  await t.expect("about", { path: "/about" });
});
add("noReferrer", "pages that send no referrer navigate back and forth quickly", async (t) => {
  await warm(t, "/", "noref-home");
  for (let round = 0; round < 3; round += 1) {
    await t.click("#about");
    await t.expect("noref-about");
    await t.click("#home");
    await t.expect("noref-home");
  }
  await t.click("#plain-about");
  await t.expect("noref-about", { path: "/about.html" });
});
add("viteRelative", "relative asset URLs from a deep route of a single-page app", async (t) => {
  await t.open("/users/7");
  await t.expect("rel-app");
  await t.waitFor(`document.body.dataset.ran === "/users/7"`);
});
add("flat", "/index and /index.html", async (t) => {
  await warm(t);
  await t.goto("/index");
  await t.expect("home");
  await t.goto("/index.html");
  await t.expect("home");
});
add("flat", "index.htm folder index", async (t) => {
  await warm(t);
  await t.goto("/docs-old");
  await t.expect("oldindex", { path: "/docs-old/" });
});
add("flat", "missing page shows 404.html with status 404", async (t) => {
  await warm(t);
  const response = await t.goto("/nowhere/at-all");
  assert.equal(response?.status(), 404);
  await t.expect("notfound");
});
add("flat", "missing asset is a 404", async (t) => {
  await warm(t);
  assert.equal(await t.eval(`fetch("/missing.js").then((r) => r.status)`), 404);
});

add("flat", "target=_blank opens in a new tab", async (t) => {
  await warm(t);
  const [popup] = await Promise.all([t.context.waitForEvent("page"), t.click("#blank")]);
  t.page = popup;
  await t.expect("about");
});
add("flat", "window.open", async (t) => {
  await warm(t);
  const [popup] = await Promise.all([t.context.waitForEvent("page"), t.eval(`void window.open("/docs/")`)]);
  t.page = popup;
  await t.expect("docs");
});
add("flat", "location.assign", async (t) => {
  await warm(t);
  await t.eval(`location.assign("about")`);
  await t.expect("about");
});
add("flat", "location.replace", async (t) => {
  await warm(t);
  await t.eval(`location.replace("docs/guide.html")`);
  await t.expect("guide");
});
add("flat", "history.pushState then reload on the pushed URL", async (t) => {
  await warm(t);
  await t.eval(`history.pushState(null, "", "/docs/guide.html")`);
  await t.page.reload();
  await t.expect("guide");
});
add(
  "flat",
  "back and forward",
  async (t) => {
    await warm(t);
    await t.click("#rel-about");
    await t.expect("about");
    await t.click("#guide");
    await t.expect("guide");
    await t.page.goBack();
    await t.expect("about");
    await t.page.goBack();
    await t.expect("home");
    await t.page.goForward();
    await t.expect("about");
  },
  { hosts: ["id", "named"] }
);
add("flat", "back to a page restored from the back-forward cache still works", async (t) => {
  await warm(t);
  await t.click("#rel-about");
  await t.expect("about");
  await t.page.goBack();
  await t.expect("home");
  await t.click("#folder-slash");
  await t.expect("docs");
});
add("flat", "GET form submit", async (t) => {
  await warm(t);
  await t.click("#search button");
  await t.expect("search", { path: "/search.html", search: "?q=hello+world" });
  assert.equal(await t.eval(`document.body.dataset.q`), "hello world");
});
add("flat", "GET form to a clean URL", async (t) => {
  await warm(t);
  await t.click("#search-clean button");
  await t.expect("search", { path: "/search", search: "?q=clean" });
});
add("flat", "meta refresh", async (t) => {
  await warm(t);
  await t.goto("/old.html");
  await t.expect("about");
});
add(
  "flat",
  "reload",
  async (t) => {
    await warm(t);
    await t.click("#rel-about");
    await t.expect("about");
    await t.page.reload();
    await t.expect("about");
  },
  { hosts: ["id", "named"] }
);
add(
  "flat",
  "hard reload",
  async (t) => {
    await warm(t);
    await t.click("#rel-about");
    await t.expect("about");
    const session = await t.context.newCDPSession(t.page);
    await session.send("Page.reload", { ignoreCache: true });
    await t.expect("about", { path: "/about.html" });
  },
  { hosts: ["id", "named"], browsers: ["chromium"] }
);
add(
  "flat",
  "deep URL as the very first visit",
  async (t) => {
    await t.open("/docs/guide.html");
    await t.expect("guide", { path: "/docs/guide.html", hash: "" });
  },
  { hosts: ["id", "named"] }
);
add("flat", "deep URL with an in-page anchor as the first visit", async (t) => {
  await t.open("/docs/guide.html", "install");
  await t.expect("guide", { path: "/docs/guide.html", hash: "#install" });
  await t.waitFor(`scrollY > 1000`);
});
add("flat", "folder without trailing slash as the first visit", async (t) => {
  await t.open("/docs");
  await t.expect("docs", { path: "/docs/" });
});
add("flat", "query string on the first visit", async (t) => {
  await t.open("/search.html?q=deep");
  await t.expect("search", { search: "?q=deep" });
  assert.equal(await t.eval(`document.body.dataset.q`), "deep");
});
add("flat", "in-page anchor", async (t) => {
  await warm(t);
  await t.eval(`window.samePage = true`);
  await t.click("#anchor");
  await t.waitFor(`location.hash === "#far" && scrollY > 1000`);
  assert.equal(await t.eval(`window.samePage`), true);
});
const downloadCase = async (t: T): Promise<void> => {
  await warm(t);
  const [download] = await Promise.all([t.page.waitForEvent("download"), t.click("#download")]);
  const path = await download.path();
  assert.equal(readFileSync(path, "utf8"), "report body\n");
};
add("flat", "<a download>", downloadCase, { modes: ["public"] });
add("flat", "<a download> on a private site, where the browser lets the service worker see downloads", downloadCase, { modes: ["private"], browsers: ["firefox"] });

add(
  "flat",
  "reopening the full link while the site is open",
  async (t) => {
    await warm(t);
    t.page = await t.context.newPage();
    await t.open("/");
    await t.expect("home", { hash: "" });
  },
  { modes: ["private"] }
);
add(
  "flat",
  "reopening a full deep link while the site is open",
  async (t) => {
    await warm(t);
    t.page = await t.context.newPage();
    await t.open("/about.html");
    await t.expect("about", { path: "/about.html", hash: "" });
  },
  { modes: ["private"] }
);
add(
  "flat",
  "reopening a deep link with key and anchor while the site is open",
  async (t) => {
    await warm(t);
    t.page = await t.context.newPage();
    await t.open("/docs/guide.html", "install");
    await t.expect("guide", { hash: "#install" });
  },
  { modes: ["private"] }
);
add("flat", "a full link whose path starts with a doubled slash while the site is open", async (t) => {
  await warm(t);
  t.page = await t.context.newPage();
  await t.open("//docs/guide.html");
  await t.expect("guide");
});
const endsStuck = async (t: T): Promise<void> => {
  await t.waitFor(`document.querySelector('[data-state="stuck"]')?.hidden === false`);
  await t.eval(`window.stayed = true`);
  await t.page.waitForTimeout(2000);
  assert.equal(await t.eval(`window.stayed === true && document.querySelector('[data-state="stuck"]')?.hidden === false`), true);
};
const forgetStoredKey = async (t: T): Promise<void> => {
  await t.eval(`new Promise((resolve, reject) => {
    const request = indexedDB.open("site", 1);
    request.onsuccess = () => {
      const transaction = request.result.transaction("keys", "readwrite");
      transaction.objectStore("keys").delete("link");
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  })`);
};
const slowHops = async (t: T): Promise<void> => {
  await t.page.addInitScript(`{
    try {
      const skew = Number(sessionStorage.getItem("test-skew") ?? 0) + 10000;
      sessionStorage.setItem("test-skew", String(skew));
      const now = Date.now;
      Date.now = () => now() + skew;
    } catch {}
  }`);
};
const hopsWithoutReferrer = async (t: T): Promise<void> => {
  await t.page.addInitScript(`Object.defineProperty(HTMLMetaElement.prototype, "content", { get: () => "", set: () => undefined })`);
};
const settles = async (t: T, start: () => Promise<unknown>, settled: string, mostLoads: number): Promise<void> => {
  const page = t.page;
  let loads = 0;
  const count = (response: Response): void => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) loads += 1;
  };
  page.on("response", count);
  try {
    await start();
    await t.waitFor(settled, 15000);
    await page.waitForTimeout(2000);
    await t.waitFor(settled);
  } finally {
    page.off("response", count);
  }
  assert.ok(loads <= mostLoads, `${loads} page loads`);
};
const showsState = (state: string): string => `document.querySelector('[data-state="${state}"]')?.hidden === false`;
const showsNotFound = `document.body?.innerText.trim() === "Not found"`;
add(
  "flat",
  "a reserved path while the site is open is a plain 404",
  async (t) => {
    await warm(t);
    const response = await t.page.goto(t.at("/__site/missing"));
    assert.equal(response?.status(), 404);
    assert.equal(await t.eval(showsNotFound), true);
  },
  { modes: ["private"] }
);
add(
  "flat",
  "a full link to a reserved path while the site is open is a plain 404",
  async (t) => {
    await warm(t);
    t.page = await t.context.newPage();
    const response = await t.open("/__site/missing");
    assert.equal(response?.status(), 404);
    assert.equal(await t.eval(showsNotFound), true);
  },
  { modes: ["private"] }
);
add(
  "flat",
  "a keyless visit to a reserved path while the site is open settles at once",
  async (t) => {
    await warm(t);
    await forgetStoredKey(t);
    await settles(t, () => t.page.goto(t.at("/__site/missing")), showsNotFound, 1);
  },
  { modes: ["private"] }
);
add(
  "flat",
  "a keyless visit with slow hops settles on the private page",
  async (t) => {
    await warm(t);
    await forgetStoredKey(t);
    await slowHops(t);
    await settles(t, () => t.page.goto(t.at("/about.html")), showsState("private"), 1);
  },
  { modes: ["private"] }
);
add(
  "noReferrer",
  "a reopen hop that arrives without a referrer stops and says what to do",
  async (t) => {
    await warm(t, "/", "noref-home");
    await hopsWithoutReferrer(t);
    await slowHops(t);
    await settles(t, () => t.click("#about"), showsState("stuck"), 4);
    await endsStuck(t);
  },
  { modes: ["private"] }
);
add(
  "noReferrer",
  "a reopen chain that keeps failing while the service worker restarts stops and says what to do",
  async (t) => {
    await warm(t, "/", "noref-home");
    const session = await t.context.newCDPSession(t.page);
    await session.send("ServiceWorker.enable");
    await t.page.route("**/__site/boot.js", async (route) => {
      await session.send("ServiceWorker.stopAllWorkers");
      await route.continue();
    });
    await hopsWithoutReferrer(t);
    await settles(t, () => t.click("#about"), showsState("stuck"), 4);
    await endsStuck(t);
  },
  { modes: ["private"], browsers: ["chromium"] }
);
add(
  "noReferrer",
  "a fresh tab opens a page whose reopen chain failed in another tab",
  async (t) => {
    await warm(t, "/", "noref-home");
    await hopsWithoutReferrer(t);
    await settles(t, () => t.click("#about"), showsState("stuck"), 4);
    t.page = await t.context.newPage();
    await t.open("/about.html");
    await t.expect("noref-about", { hash: "" });
  },
  { modes: ["private"] }
);
add(
  "flat",
  "several tabs opening the same full link together",
  async (t) => {
    await warm(t);
    const tabs = await Promise.all([1, 2, 3, 4, 5].map(() => t.context.newPage()));
    await Promise.all(
      tabs.map(async (tab) => {
        const opened = makeT(t.mode, t.browserName, t.context, tab, t.site);
        await opened.open("/about.html");
        await opened.expect("about", { hash: "" });
      })
    );
  },
  { modes: ["private"] }
);
add(
  "flat",
  "opening the same full link again and again in one tab never ends on a dead end",
  async (t) => {
    await warm(t);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await t.page.goto("about:blank");
      await t.open("/about.html");
      await t.waitFor(`document.querySelector('meta[name="page"]')?.content === "about" || ${showsState("stuck")}`);
      if (await t.eval(showsState("stuck"))) {
        await t.page.goto("about:blank");
        await t.open("/about.html");
      }
      await t.expect("about", { hash: "" });
    }
  },
  { modes: ["private"] }
);
add(
  "flat",
  "a POST to a reserved path with a malformed escape is a local 404",
  async (t) => {
    await warm(t);
    for (const path of ["/__site/%zz", "/%5F%5Fsite/%zz", "/__site/meta%zz"]) {
      const answer = await t.eval<{ status: number; type: string }>(
        `fetch(location.origin + ${JSON.stringify(path)}, { method: "POST", body: "x" }).then((r) => ({ status: r.status, type: r.headers.get("content-type") }))`
      );
      assert.equal(answer.status, 404, path);
      assert.match(answer.type, /^text\/plain/, path);
    }
  },
  { modes: ["private"] }
);
add(
  "flat",
  "requests the service worker passes to the network carry no referrer",
  async (t) => {
    await warm(t);
    await t.goto("/about.html?secret=1");
    await t.expect("about");
    const referrers: string[] = [];
    const record = (response: Response): void => {
      if (response.fromServiceWorker()) return;
      if (new URL(response.url()).pathname.startsWith("/__site/")) referrers.push(response.request().headers()["referer"] ?? "");
    };
    t.context.on("response", record);
    try {
      await t.eval(`Promise.all(["/__site/meta", "/__site/entries/0"].map((path) => fetch(path, { cache: "no-store" }).then((r) => r.arrayBuffer())))`);
    } finally {
      t.context.off("response", record);
    }
    assert.ok(referrers.length >= 2, `${referrers.length} requests`);
    assert.deepEqual(
      referrers.filter((referrer) => referrer.includes("secret")),
      []
    );
  },
  { modes: ["private"], browsers: ["chromium"] }
);
add(
  "flat",
  "several tabs",
  async (t) => {
    await warm(t);
    const first = t.page;
    t.page = await t.context.newPage();
    await t.goto("/about");
    await t.expect("about");
    t.page = first;
    await t.click("#folder-slash");
    await t.expect("docs");
  },
  { hosts: ["id", "named"] }
);
add(
  "flat",
  "the service worker is stopped",
  async (t) => {
    await warm(t);
    const session = await t.context.newCDPSession(t.page);
    await session.send("ServiceWorker.enable");
    await session.send("ServiceWorker.stopAllWorkers");
    await t.click("#rel-about");
    await t.expect("about");
    await session.send("ServiceWorker.stopAllWorkers");
    await t.eval(`document.getElementById("guide").click()`);
    await t.expect("guide");
  },
  { modes: ["private"], browsers: ["chromium"] }
);
add(
  "flat",
  "a redeploy while a tab is open shows on the next navigation",
  async (t) => {
    const version = (number: number): Files => ({
      "index.html": htmlPage(`home-v${number}`, `<a id="next" href="next.html">next</a>`, `<link rel="stylesheet" href="style.css">`),
      "next.html": htmlPage(`next-v${number}`, "", `<link rel="stylesheet" href="style.css">`),
      "style.css": `h1{color:rgb(${number}, 0, 0)}`
    });
    const site = await t.fresh(version(1));
    t.site = site;
    t.page = await t.context.newPage();
    const fresh = makeT(t.mode, t.browserName, t.context, t.page, site);
    await fresh.open("/");
    await fresh.expect("home-v1");
    await t.redeploy(site, version(2));
    await fresh.click("#next");
    await fresh.expect("next-v2");
    await fresh.waitFor(`getComputedStyle(document.querySelector("h1")).color === "rgb(2, 0, 0)"`);
    await fresh.page.goBack();
    await fresh.page.reload();
    await fresh.expect("home-v2");
  },
  { hosts: ["named"] }
);

add("kitchen", "classic script", async (t) => {
  await warm(t, "/", "kitchen");
  await t.waitFor(`window.classicRan === true`);
});
add("kitchen", "module script with a static import", async (t) => {
  await warm(t, "/", "kitchen");
  await t.waitFor(`window.moduleValue === "static"`);
});
add("kitchen", "dynamic import()", async (t) => {
  await warm(t, "/", "kitchen");
  await t.waitFor(`window.lazyValue === "dynamic"`);
});
add("kitchen", "CSS @import", async (t) => {
  await warm(t, "/", "kitchen");
  await t.waitFor(`getComputedStyle(document.getElementById("styled")).color === "rgb(0, 128, 0)"`);
});
add("kitchen", "CSS url() image", async (t) => {
  await warm(t, "/", "kitchen");
  await t.waitFor(`/dot\\.png/.test(getComputedStyle(document.getElementById("styled")).backgroundImage)`);
  const width = await t.eval(
    `new Promise((done) => { const url = getComputedStyle(document.getElementById("styled")).backgroundImage.slice(5, -2); const image = new Image(); image.onload = () => done(image.naturalWidth); image.onerror = () => done(-1); image.src = url; })`
  );
  assert.equal(width, 4);
});
add("kitchen", "web font from CSS", async (t) => {
  await warm(t, "/", "kitchen");
  await t.waitFor(`document.readyState === "complete"`);
  const loaded = await t.eval(`document.fonts.load("16px NavTest").then((faces) => faces.length, () => -1)`);
  assert.equal(loaded, 1);
  await t.waitFor(`document.getElementById("font").offsetWidth > document.getElementById("fallback").offsetWidth * 1.5`);
});
add("kitchen", "img srcset", async (t) => {
  await warm(t, "/", "kitchen");
  await t.waitFor(`document.getElementById("srcset").complete && document.getElementById("srcset").naturalWidth === 4`);
});
add("kitchen", "video plays and seeks", async (t) => {
  await warm(t, "/", "kitchen");
  const seeked = await t.eval(
    `new Promise((done) => { const video = document.getElementById("video"); const started = Date.now(); const ready = () => { if (video.readyState >= 2) done("ok"); else if (Date.now() - started > 10000) done("state " + video.readyState); else setTimeout(ready, 50); }; const seek = () => { video.addEventListener("seeked", ready, { once: true }); video.currentTime = 2; }; video.addEventListener("error", () => done("error " + (video.error && video.error.code))); if (video.readyState >= 1) seek(); else video.addEventListener("loadedmetadata", seek, { once: true }); if (video.networkState === 3) done("no source"); })`
  );
  assert.equal(seeked, "ok");
});
add("kitchen", "audio plays and seeks", async (t) => {
  await warm(t, "/", "kitchen");
  const seeked = await t.eval(
    `new Promise((done) => { const audio = document.getElementById("audio"); const started = Date.now(); const ready = () => { if (audio.readyState >= 2) done("ok"); else if (Date.now() - started > 10000) done("state " + audio.readyState); else setTimeout(ready, 50); }; const seek = () => { audio.addEventListener("seeked", ready, { once: true }); audio.currentTime = 2; }; audio.addEventListener("error", () => done("error " + (audio.error && audio.error.code))); if (audio.readyState >= 1) seek(); else audio.addEventListener("loadedmetadata", seek, { once: true }); })`
  );
  assert.equal(seeked, "ok");
});
add("kitchen", "iframe and a link inside it", async (t) => {
  await warm(t, "/", "kitchen");
  const frameName = `document.getElementById("frame").contentDocument?.querySelector('meta[name="page"]')?.content`;
  await t.waitFor(`${frameName} === "frame"`);
  await t.eval(`document.getElementById("frame").contentDocument.getElementById("next").click()`);
  await t.waitFor(`${frameName} === "frame2"`);
});
add("kitchen", "fetch JSON with a query string", async (t) => {
  await warm(t, "/", "kitchen");
  await t.waitFor(`window.results?.json === true`);
});
add("kitchen", "Web Worker with importScripts", async (t) => {
  await warm(t, "/", "kitchen");
  await t.waitFor(`window.results?.worker === "worker ok"`);
});
add("kitchen", "module Web Worker", async (t) => {
  await warm(t, "/", "kitchen");
  await t.waitFor(`window.results?.moduleWorker === "static"`);
});
add("kitchen", "web manifest and favicon", async (t) => {
  await warm(t, "/", "kitchen");
  const manifest = await t.eval(`fetch(document.querySelector('link[rel="manifest"]').href).then((r) => r.json()).then((m) => m.name, (e) => String(e))`);
  assert.equal(manifest, "Kitchen");
  assert.equal(await t.eval(`fetch(document.querySelector('link[rel="icon"]').href).then((r) => r.status)`), 200);
});
add("kitchen", "source map", async (t) => {
  await warm(t, "/", "kitchen");
  assert.equal(await t.eval(`fetch("js/classic.js.map").then((r) => r.json()).then((m) => m.version, (e) => String(e))`), 3);
});
add("kitchen", "WebAssembly streaming compile", async (t) => {
  await warm(t, "/", "kitchen");
  await t.waitFor(`window.results?.wasm !== undefined`);
  assert.equal(await t.eval(`window.results.wasm`), 5);
});

add("ownServiceWorker", "a site that registers its own service worker keeps working", async (t) => {
  await warm(t, "/", "ownsw-home");
  const outcome = await t.eval<string>(`window.registration`);
  if (t.mode === "public") {
    assert.equal(outcome, "registered");
    await t.eval(`navigator.serviceWorker.ready`);
    await t.page.reload();
    await t.expect("ownsw-home");
    await t.waitFor(`navigator.serviceWorker.controller !== null`);
    assert.equal(await t.eval(`fetch("/sw-hello").then((r) => r.text())`), "hello from the site's worker");
  }
  await t.page.reload();
  await t.expect("ownsw-home");
  await t.click("#about");
  await t.expect("ownsw-about");
});

add("viteSpa", "history-router deep route as the first visit", async (t) => {
  await t.open("/users/7");
  await t.expect("spa-user", { path: "/users/7" });
  assert.equal(await t.eval(`document.body.dataset.param`), "7");
});
add("viteSpa", "pushState route survives a reload", async (t) => {
  await warm(t, "/", "spa-home");
  await t.click("#to-user");
  await t.expect("spa-user", { path: "/users/3" });
  await t.page.reload();
  await t.expect("spa-user", { path: "/users/3" });
});
add("viteSpa", "route with a dot in it", async (t) => {
  await t.open("/users/john.doe");
  await t.expect("spa-user");
  assert.equal(await t.eval(`document.body.dataset.param`), "john.doe");
});
add("viteSpa", "route with a query string", async (t) => {
  await t.open("/users/3?tab=posts");
  await t.expect("spa-user", { search: "?tab=posts" });
});
add("viteSpa", "back and forward between routes", async (t) => {
  await warm(t, "/", "spa-home");
  await t.click("#to-user");
  await t.expect("spa-user");
  await t.page.goBack();
  await t.expect("spa-home");
  await t.page.goForward();
  await t.expect("spa-user");
});
add("viteSpa", "unknown route reaches the app's own not-found view", async (t) => {
  await warm(t, "/", "spa-home");
  const response = await t.goto("/no/such/route");
  assert.equal(response?.status(), 200);
  await t.expect("spa-notfound");
});
add("viteSpa", "missing asset in a single-page app is a 404", async (t) => {
  await warm(t, "/", "spa-home");
  assert.equal(await t.eval(`fetch("/assets/missing-9z.js").then((r) => r.status)`), 404);
});
add("viteSpa", "reserved paths spelled with a doubled slash or percent-encoding never reach the app", async (t) => {
  await warm(t, "/", "spa-home");
  for (const path of ["//__site/meta", "/%5F%5Fsite/meta", "//__site/entries/0", "/__site/missing", "/__site/entries/x"]) {
    const answer = await t.eval<{ status: number; type: string; bootstrap: boolean }>(
      `fetch(location.origin + ${JSON.stringify(path)}).then((r) => ({ status: r.status, type: r.headers.get("content-type"), bootstrap: r.headers.has("x-site-bootstrap") }))`
    );
    assert.equal(answer.status, 404, path);
    assert.match(answer.type, /^text\/plain/, path);
    assert.equal(answer.bootstrap, false, path);
  }
});
add("spaWithNotFound", "a real 404.html wins over guessing a single-page app", async (t) => {
  await warm(t, "/", "spa-home");
  const response = await t.goto("/users/3");
  assert.equal(response?.status(), 404);
  await t.expect("real-404");
});

add("hashSpa", "hash route as the first visit", async (t) => {
  await t.open("/", "/users/3");
  await t.expect("spa-user", { hash: "#/users/3" });
});
add("hashSpa", "hash route survives a reload and back", async (t) => {
  await warm(t, "/", "spa-home");
  await t.click("#to-user");
  await t.expect("spa-user");
  await t.page.reload();
  await t.expect("spa-user");
  await t.page.goBack();
  await t.expect("spa-home");
});
add(
  "hashSpa",
  "reopening the full link does not hand the key to the hash router",
  async (t) => {
    await warm(t, "/", "spa-home");
    t.page = await t.context.newPage();
    await t.open("/");
    await t.expect("spa-home", { hash: "" });
  },
  { modes: ["private"] }
);

add("nextExport", "page.html next to page/ and nested pages", async (t) => {
  await warm(t, "/", "next-home");
  await t.click("#about");
  await t.expect("next-about", { path: "/about" });
  await t.goto("/blog");
  await t.expect("next-blog", { path: "/blog" });
  await t.goto("/blog/first-post");
  await t.expect("next-post");
});
add("nextExport", "page.html reached with a trailing slash", async (t) => {
  await warm(t, "/", "next-home");
  await t.goto("/blog/");
  await t.expect("next-blog");
});
add("nextExport", "_next chunks and CSS load", async (t) => {
  await warm(t, "/", "next-home");
  await t.waitFor(`window.nextChunk === true && getComputedStyle(document.querySelector("h1")).color === "rgb(0, 0, 255)"`);
});
add("nextExport", "RSC payload fetch with a query string", async (t) => {
  await warm(t, "/", "next-home");
  assert.equal(await t.eval(`fetch("/about.txt?_rsc=1x2y").then((r) => r.text())`), "1:about-rsc-payload\n");
});
add("nextExport", "404.html", async (t) => {
  await warm(t, "/", "next-home");
  const response = await t.goto("/nope");
  assert.equal(response?.status(), 404);
  await t.expect("next-404");
});
add("nextSlash", "trailingSlash: true pages", async (t) => {
  await warm(t, "/", "nexts-home");
  await t.goto("/about");
  await t.expect("nexts-about", { path: "/about/" });
  await t.click("#home");
  await t.expect("nexts-home", { path: "/" });
  await t.goto("/blog/first-post");
  await t.expect("nexts-post", { path: "/blog/first-post/" });
});
add("astro", "directory pages and hoisted module scripts", async (t) => {
  await warm(t, "/", "astro-home");
  await t.goto("/about");
  await t.expect("astro-about", { path: "/about/" });
  await t.waitFor(`window.astroRan === true`);
  const response = await t.goto("/nope");
  assert.equal(response?.status(), 404);
  await t.expect("astro-404");
});
add("docusaurus", "client-routed URL without trailing slash survives a reload", async (t) => {
  await warm(t, "/", "docu-home");
  await t.click("#intro");
  await t.expect("docu-intro", { path: "/docs/intro" });
  await t.page.reload();
  await t.expect("docu-intro");
  await t.click("#next");
  await t.expect("docu-next");
  await t.page.reload();
  await t.expect("docu-next");
});
add("docusaurus", "deep docs URL as the first visit", async (t) => {
  await t.open("/docs/intro");
  await t.expect("docu-intro");
});
add("hugo", "pretty URLs and a stylesheet with an integrity hash", async (t) => {
  await warm(t, "/", "hugo-home");
  await t.waitFor(`getComputedStyle(document.querySelector("h1")).color === "rgb(128, 0, 128)"`);
  await t.goto("/posts/my-post");
  await t.expect("hugo-post", { path: "/posts/my-post/" });
  await t.waitFor(`getComputedStyle(document.querySelector("h1")).color === "rgb(128, 0, 128)"`);
});
add("hugo", "RSS feed", async (t) => {
  await warm(t, "/", "hugo-home");
  const type = await t.eval<string>(`fetch("/index.xml").then((r) => r.headers.get("content-type"))`);
  assert.match(type, /xml/);
});
add("jekyll", "pages and dated posts without .html", async (t) => {
  await warm(t, "/", "jekyll-home");
  await t.goto("/about");
  await t.expect("jekyll-about");
  await t.goto("/2026/11/26/welcome-to-jekyll");
  await t.expect("jekyll-post");
  await t.goto("/2026/11/26/welcome-to-jekyll.html");
  await t.expect("jekyll-post");
});
add("mkdocs", "directory URLs with relative links and assets", async (t) => {
  await warm(t, "/", "mk-home");
  await t.goto("/about");
  await t.expect("mk-about", { path: "/about/" });
  await t.waitFor(`getComputedStyle(document.querySelector("h1")).color === "rgb(10, 20, 30)" && document.body.dataset.search === "1"`);
  await t.click("#home");
  await t.expect("mk-home", { path: "/" });
});
add("eleventy", "permalink folders", async (t) => {
  await warm(t, "/", "11ty-home");
  await t.goto("/blog/post-1");
  await t.expect("11ty-post", { path: "/blog/post-1/" });
});
add("surge", "200.html serves unknown routes", async (t) => {
  await warm(t, "/", "surge-home");
  const response = await t.goto("/some/route");
  assert.equal(response?.status(), 200);
  await t.expect("surge-app");
  await t.goto("/about");
  await t.expect("surge-about");
});
add("ghPagesSpa", "the GitHub Pages 404.html redirect trick", async (t) => {
  await warm(t, "/", "gh-home");
  await t.goto("/app/route?x=1");
  await t.expect("gh-route", { path: "/app/route", search: "?x=1" });
});
add("basePath", "assets built for a base path load at the root", async (t) => {
  await warm(t, "/", "base-app");
  await t.waitFor(`document.body.dataset.ran === "yes"`);
});
add("basePath", "the base path itself serves the site", async (t) => {
  await warm(t, "/", "base-app");
  await t.goto("/myrepo/");
  await t.expect("base-app");
  await t.waitFor(`document.body.dataset.ran === "yes"`);
});
add("caseFolder", "a first segment that names a folder in another letter case is not a base path", async (t) => {
  await t.open("/docs/readme.html");
  await t.expect("case-readme");
  const response = await t.goto("/docs/assets/app.js");
  assert.equal(response?.status(), 404);
  await t.expect("case-404");
});
add("xhtmlPage", "an XHTML page counts as a second page, so missing routes are 404s", async (t) => {
  await warm(t, "/", "xhtml-home");
  await t.goto("/guide.xhtml");
  await t.expect("xhtml-guide");
  const response = await t.goto("/nope");
  assert.equal(response?.status(), 404);
});
add("plain", "a multi-page site without 404.html still has real 404s", async (t) => {
  await warm(t, "/", "plain-home");
  const response = await t.goto("/nope");
  assert.equal(response?.status(), 404);
  await t.goto("/about");
  await t.expect("plain-about");
});
add("landing", "a one-page site without scripts still has real 404s", async (t) => {
  await warm(t, "/", "landing");
  const response = await t.goto("/nope");
  assert.equal(response?.status(), 404);
});

type RuleReply = { status: number; rule: string | null; name: string | null; text: string };
const fetchWithRules = (t: T, path: string): Promise<RuleReply> =>
  t.eval<RuleReply>(`fetch(${JSON.stringify(path)}).then(async (r) => ({ status: r.status, rule: r.headers.get("x-rule"), name: r.headers.get("x-name"), text: await r.text() }))`);

add("rulesNav", "an unforced rule gives way to any page the navigation rules find and a forced rule does not", async (t) => {
  await warm(t, "/", "rn-home");
  await t.goto("/about");
  await t.expect("rn-about", { path: "/about" });
  await t.goto("/contact");
  await t.expect("rn-contact", { path: "/contact" });
  await t.goto("/guide");
  await t.expect("rn-guide", { path: "/guide" });
  await t.goto("/docs");
  await t.expect("rn-docs", { path: "/docs/" });
  await t.goto("/legacy/");
  await t.expect("rn-legacy", { path: "/legacy/" });
  await t.goto("/team");
  await t.expect("rn-new", { path: "/new" });
  await t.goto("/TEAM");
  await t.expect("rn-team", { path: "/TEAM" });
});
add("rulesNav", "explicit rules win over 200.html and base-path assets", async (t) => {
  await warm(t, "/", "rn-home");
  await t.goto("/blog/post");
  await t.expect("rn-new", { path: "/new" });
  await t.goto("/myrepo/assets/app.js");
  await t.expect("rn-new", { path: "/new" });
  await t.goto("/some/route");
  await t.expect("rn-shell", { path: "/some/route" });
  const asset = await fetchWithRules(t, "/other/assets/app.js");
  assert.deepEqual(asset, { status: 200, rule: "all", name: null, text: "window.app = true;" });
});
add("rulesNav", "rewrites find their page with the navigation rules and never chain or fall back", async (t) => {
  await warm(t, "/", "rn-home");
  await t.goto("/help");
  await t.expect("rn-about", { path: "/help" });
  await t.goto("/manual");
  await t.expect("rn-docs", { path: "/manual" });
  await t.goto("/g");
  await t.expect("rn-guide", { path: "/g" });
  for (const path of ["/gone/thing", "/chain"]) {
    const response = await t.goto(path);
    assert.equal(response?.status(), 404, path);
    assert.equal(await t.eval(showsNotFound), true, path);
  }
});
add("rulesNav", "redirects from rules and from the navigation rules never loop", async (t) => {
  await warm(t, "/", "rn-home");
  await t.goto("/s/page");
  await t.expect("rn-s-page", { path: "/s/page" });
  await t.goto("/s/page/");
  await t.expect("rn-s-page", { path: "/s/page" });
  await t.goto("/f/sub");
  await t.expect("rn-f-sub", { path: "/f/sub/" });
  await t.goto("/f/sub/");
  await t.expect("rn-f-sub", { path: "/f/sub/" });
  await t.goto("/c/x/");
  await t.expect("rn-c-x", { path: "/C/x/" });
});
add("rulesNav", "rules match the normalised path", async (t) => {
  await warm(t, "/", "rn-home");
  for (const path of ["//old-page", "/old%2Dpage", "/x/%2e%2e/old-page"]) {
    await t.goto(path);
    await t.expect("rn-new", { path: "/new" });
  }
  const deep = await fetchWithRules(t, "/deep//dune");
  assert.equal(deep.name, "dune");
});
add("rulesNav", "header rules reach every page the navigation rules serve and the rule files stay hidden", async (t) => {
  await warm(t, "/", "rn-home");
  for (const path of ["/", "/some/route", "/GUIDE", "/contact", "/help", "/docs/"]) {
    const reply = await fetchWithRules(t, path);
    assert.equal(reply.status, 200, path);
    assert.equal(reply.rule, "all", path);
  }
  for (const path of ["/nope.js", "/gone/thing"]) {
    const reply = await fetchWithRules(t, path);
    assert.deepEqual([reply.status, reply.rule], [404, "all"], path);
  }
  for (const path of ["/_redirects", "/_Redirects", "/_HEADERS"]) {
    const reply = await fetchWithRules(t, path);
    assert.equal(reply.status, 200, path);
    assert.doesNotMatch(reply.text, /X-Rule|\/old-page/, path);
  }
});
add("rulesSpa", "rules win over the automatic single-page-app fallback, which still carries the site's headers", async (t) => {
  await warm(t, "/", "rs-app");
  await t.goto("/old");
  await t.expect("rs-app", { path: "/dashboard" });
  const route = await fetchWithRules(t, "/dashboard");
  assert.deepEqual([route.status, route.rule], [200, "spa"]);
  const response = await t.goto("/missing/thing");
  assert.equal(response?.status(), 404);
  assert.equal(await t.eval(showsNotFound), true);
  const missing = await fetchWithRules(t, "/missing/thing");
  assert.deepEqual([missing.status, missing.rule], [404, "spa"]);
});

for (const browserName of browserNames) {
  describe.concurrent(browserName, () => {
    for (const mode of modes) {
      for (const item of cases) {
        if (item.modes !== undefined && !item.modes.includes(mode)) continue;
        if (item.browsers !== undefined && !item.browsers.includes(browserName)) continue;
        for (const host of item.hosts ?? ["id"]) {
          test(`${browserName} ${mode} ${host} ${item.site}: ${item.name}`, async () => {
            const browser = browsers.get(browserName);
            assert.ok(browser);
            const site = await deployed(item.site, mode, host);
            const context = await browser.newContext({ acceptDownloads: true });
            try {
              const t = makeT(mode, browserName, context, await context.newPage(), site);
              await item.run(t);
            } finally {
              await context.close();
            }
          });
        }
      }
    }
  });
}
