<p align="center">
  <img src="public/apple-touch-icon.png" width="72" height="72" alt="" />
</p>

<h1 align="center">site</h1>

<p align="center">
  <strong>Static sites, live in one command.</strong>
</p>

<p align="center">
  <a href="https://github.com/Stoffbergie/site/actions/workflows/deploy.yml"><img src="https://github.com/Stoffbergie/site/actions/workflows/deploy.yml/badge.svg" alt="Deploy" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-171717" alt="MIT license" /></a>
</p>

<p align="center">
  <a href="#start-deploying">Get started</a> ·
  <a href="#everyday-commands">Commands</a> ·
  <a href="#names">Names</a> ·
  <a href="#keep-a-site-private">Private sites</a> ·
  <a href="https://site.stoff.dev">Website</a> ·
  <a href="SKILL.md">For agents</a>
</p>

---

## Start deploying

Install with Homebrew:

```sh
brew install stoffbergie/tap/site
```

Then put a folder on the web:

```console
$ site dist
12 files · 184.2 KB
https://k3m9xq2a.site.stoff.dev
```

The link is copied to your clipboard. Use `site --no-copy dist` to leave your clipboard alone.

**One request, no build step.** The whole folder goes up in a single upload and is live the moment the link prints. No account to create, no DNS or certificate to wait for. Deploys stay until you remove them.

<details>
<summary>Other downloads</summary>

Download a binary for macOS, Linux or Windows from [Releases](https://github.com/Stoffbergie/site/releases). The `site-x86_64-unknown-linux-musl.tar.gz` archive does not depend on glibc.

</details>

## Everyday commands

| What you want                   | Command                            |
| ------------------------------- | ---------------------------------- |
| Deploy a folder                 | `site dist`                        |
| Deploy it under a name          | `site dist -n todo`                |
| Keep it private                 | `site dist -e`                     |
| Deploy loose files at the root  | `site index.html style.css`        |
| Deploy command output as a page | `cat page.html \| site -`          |
| A single-page app               | `site dist --spa`                  |
| See your names and deploys      | `site ls`                          |
| Roll a name back                | `site point todo k3m9xq2a`         |
| Remove a deploy or a name       | `site rm k3m9xq2a`, `site rm todo` |

Links go to stdout; details go to stderr. Names starting with a dot stay private, so `.env`, `.git`, `.npmrc` and editor folders never deploy; `.well-known/` does, with the right types for extensionless files like `apple-app-site-association` and `webfinger`. Anything left out other than junk like `.git` and `.DS_Store` is named in one line, up to eight names and then a count. The rule covers what a folder walk finds and the name of each file you pass; a folder or file you name yourself is deployed as you asked, and a symlink you name is followed. Symlinks and `node_modules` are left out too. On a private site `.well-known/` files open only in a browser with the link, so apps and other services cannot read them.

## Names

```sh
site dist -n todo
```

prints `https://todo.site.stoff.dev`, and the deploy's own URL on stderr. The first deploy claims the name; every later `-n todo` with your key moves it to the new deploy, visible on the very next page load. Someone else's key gets "that name is taken".

Every deploy keeps its own URL, so rolling back is pointing the name at an earlier one:

```sh
site ls
site point todo k3m9xq2a
```

A deploy a name points at can't be removed until the name moves or is released with `site rm todo`. A released name stays yours: only your key can claim it again.

Names are 3 to 40 lowercase letters, digits and hyphens. Each key holds up to 20.

## Keep a site private

```console
$ site dist -e
3 files · 9.1 KB
https://k3m9xq2a.site.stoff.dev/#4f0cX2…
```

`-e` encrypts every file, path and content type on your machine before upload. The key is in the link after `#`, which browsers never send to a server, so the server only ever stores ciphertext. Open the full link in a browser and the site works as usual, pages, images, clean URLs, `--spa` and media seeking included; it is decrypted in the browser.

Name it and the link stays the same across redeploys:

```console
$ site dist -e -n todo
https://todo.site.stoff.dev/#9b1e…
```

Links are derived from your key, so `site ls` prints them again on any machine with that key. Nothing new to save.

What it protects and what it doesn't:

- Anyone with the full link can read the site. Share it like a password.
- The server, and anyone with only the URL before `#`, cannot. They get a page saying the site is private.
- The address of a page someone opens directly or hard-reloads reaches the server as a request path, like any URL. Contents, and the names of everything else, do not.
- Re-opening the full link in a tab that already shows the site leaves the key in the address bar, where the page's scripts can read it, until the next navigation.
- To take access away, remove the deploy with `site rm`, or release the name. There is no other revocation.
- A name holding an encrypted site never turns public by accident: deploying to it without `-e` is refused.
- It needs JavaScript and service workers, so it opens in current browsers but not in private windows that turn service workers off. Encrypting needs the CLI; there is no encrypted deploy through curl.

## Moving from localhost or another host

Every site is served over HTTPS and sends `Access-Control-Allow-Origin` for any origin, credentials included, answers preflight requests, and allows `Timing-Allow-Origin` and cross-origin embedding, so pages elsewhere can use its files, fonts, images, modules and iframes. Each of these headers you set or remove in `_headers` is yours and the others keep their defaults; credentials are allowed by default only for the origin `Access-Control-Allow-Origin` names. Sites are read-only: anything but GET, HEAD and OPTIONS gets 405.

What the address change breaks outside site: an API's CORS allowlist, OAuth redirect URLs, and keys restricted to a domain (Maps, Firebase and similar) need the new address added on their side.

Browsers keep storage, sign-ins, installs and service workers per address, and every deploy gets a new one. Use `-n` for anything people come back to.

Sites under `site.stoff.dev` share a parent domain. Each site's localStorage, IndexedDB and service workers are its own, but a cookie set with `Domain=site.stoff.dev` reaches every site, so do not trust cookies for anything that matters.

## Your key

There's no login. The first deploy makes a random key on your machine, and that key owns your deploys and names. Only a hash of it reaches the server's storage.

To use the same sites from another machine, print the key on the first and save it on the second:

```sh
site key                 # on the first machine
site key site_….…        # on the second
```

The key has two parts joined by a dot. The part before the dot signs you in. The part after it never leaves your machines and makes the links of private sites, so the server cannot open them.

`site key <key>` asks before replacing a different key, and refuses in scripts. In CI, set `SITE_KEY` instead.

## What gets served

| Request            | Serves                                                         |
| ------------------ | -------------------------------------------------------------- |
| `/`                | `index.html` (or `index.htm`)                                  |
| `/docs/`           | `docs/index.html`                                              |
| `/docs`            | a redirect to `/docs/`, keeping the query string and `#anchor` |
| `/about`           | `about.html`, `about.htm`, or a redirect to `/about/`          |
| `/about/`          | a redirect to `/about` when `about.html` is a page             |
| `/ABOUT`, `/Café`  | the file whose name differs only in letter case or accent form |
| `/myrepo/assets/x` | `assets/x` when the build was made for a base path             |
| `/.well-known/x`   | `.well-known/x`; other dot-names are never deployed            |
| Unknown route      | `index.html` with `--spa` or for a single-page app, `200.html` |
| Anything else      | `404.html` with status 404, or a plain 404                     |

An exact file always wins. A single-page app needs no flag when `index.html` is its only HTML or XHTML page, it has a script and there is no `404.html`. A route is any path without a content type: one that does not end in an extension from the type table below, like `.js`, `.png` or `.rss`, and is not a registered `.well-known` file, so `/users/john.doe` is a route. Letter case and accent form never change a name starting with a dot, so `/.WELL-KNOWN/` is not `/.well-known/`, and when two files differ only in letter case or accent form, only their exact names find them. Redirects and fallback pages carry the same cross-origin headers as files. Encrypted sites follow the same rules, applied in the browser, and a link may carry an anchor after the key: `https://<id>.site.stoff.dev/guide#<key>#install`. With no `index.html`, a lone HTML file is the page at `/`, a single file is served at `/` and under its name, and anything else shows a file list.

Rules in `_redirects` (below) come before this table. A rule without `!` gives way to whatever names a real page or folder here: the exact file, `.html` or `.htm`, a folder index or the folder redirect, and the same names in another letter case or accent form; a rule with `!` wins over all of it. `200.html`, the single-page app fallback, base-path assets and `404.html` come after every rule, so an explicit rule wins over them. A `200` or `404` rewrite finds its page with the same name rules, but with no fallback and no further rule, so a rewrite to a missing page is a 404. Rule paths match letter case exactly, as on Netlify, on the path as it is looked up here: escapes decoded and doubled slashes collapsed, so `//old` and `/%6Fld` match `/old`. A rule never only adds or removes a trailing slash, so rules and the redirects above cannot send a browser in a loop. `_redirects` and `_headers` count for none of these rules: they are never the page at `/`, never make a deploy a single-page app and never show in a file list. Header rules apply to every answer in this table except redirects.

Every file is served with its standard content type, taken from its extension: the same table as the `mime` and `mime-db` packages that Cloudflare and GitHub Pages use, so feeds, manifests, source maps, modules, fonts, media, HLS and DASH streams, captions, 3D models, `.wasm` and documents behave as they do elsewhere. Files with an unknown extension or none, like `LICENSE` or `CNAME`, are served as UTF-8 plain text when they look like text and as `application/octet-stream`, a download, when they do not. Nothing is ever sniffed into HTML or script.

Text files are compressed before upload and served compressed. Text in any encoding reads as it does from disk: UTF-8 files are sent with `charset=utf-8`, and files in another encoding (Windows-1252, Shift_JIS, GB18030, UTF-16 and so on) or that declare one in a `<meta charset>`, `@charset` or XML declaration are sent with no charset, so the browser follows the file's own declaration. That holds for files with an unknown extension or none and for compressed build output served decoded too. Other files support byte ranges. Compressed build output works as on any well-configured server: a `.gz`, `.br` or `.unityweb` file a page loads directly (`.js`, `.mjs`, `.wasm`, `.css`, `.html`, `.svg`, `.data`, `.pck`, `.mem`, `.symbols.json` under the suffix, as Unity, Emscripten and Godot write) is served decoded with the inner file's type, so `game.wasm.gz` streams as `application/wasm`. One that unpacks to more than 100 MB fails the deploy. Any other `.gz` or `.br`, such as `backup.tar.gz` or `data.csv.gz`, arrives byte for byte as the compressed file. A `.gz` or `.br` copy next to a file holding the same content (from compression plugins or `gzip_static` setups) is left out, since site compresses the original itself. Deploy URLs are cached by browsers for a year, since a deploy never changes; named URLs revalidate on every load.

### Redirects and headers

A `_redirects` or `_headers` file at the root of the folder works as it does on Netlify and Cloudflare Pages, so a site moved from there behaves the same. Both are read when you deploy and are never served.

```txt
# _redirects
/old          /new             301
/blog/*       /posts/:splat    301
/news/:year/:slug   /articles/:year/:slug
/search       /find?from=search
/docs         https://docs.example.com   302
/forced       /new             301!
/closed/*     /closed.html     404
/*            /index.html      200
```

| `_redirects`                  | What happens                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `301` `302` `303` `307` `308` | Redirect; `302` when no status is given. The query string is kept unless the destination has its own |
| `200`                         | Serve another path of this site at this address (single-page app fallbacks)                          |
| `404`                         | Serve that page with status 404, or `404.html` if it is missing, never the `--spa` app shell         |
| `*` and `:splat`, `:name`     | Splat across segments, placeholder for one segment                                                   |
| `!` after the status          | Apply even when a page exists at the path; otherwise the page wins                                   |
| Order                         | The first matching line that applies wins; a trailing slash does not matter                          |
| Loops                         | A rule back to the address requested is skipped; rules that redirect to each other are reported      |
| `https://` destination        | Redirect to another site                                                                             |

```txt
# _headers
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Content-Security-Policy: default-src 'self'
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/*.jpg
  ! Content-Security-Policy
```

Every matching block applies in file order; a header set twice is joined with a comma, `! Name` removes it, and `:splat` and `:name` work in values. Custom headers apply to pages, files, fallback pages and 404 responses, not to redirects.

What is left out, reported when you deploy and skipped without failing it:

- Proxying (`200` to another site), country, language, role and cookie conditions, query-parameter matching, signed rules and rules for other domains: they need a server.
- Headers site sets itself: `Set-Cookie` (a cookie could reach every other site under the domain), `ETag`, `Vary`, `Location`, `X-Content-Type-Options`, content length, encoding and range headers, and CDN cache controls.
- Headers that would reach other sites, since every site shares one domain: `Clear-Site-Data` (it clears cookies for the whole domain), `Origin-Agent-Cluster`, `NEL`, `Report-To` and the device-bound session headers.
- `Cache-Control` on named URLs, unless it has a `no-cache` or `no-store` directive of its own: named URLs always revalidate so a redeploy shows on the next load. On deploy URLs it is used as written. A value with an unclosed quote is never used.
- A redirect written as a path that would leave the site, such as `/go/* //:splat`, is skipped and the next matching line is tried. So is one whose address, with the query it keeps, would pass 16,384 characters.
- Limits: 10,000 redirects, of which 1,000 may use `*` or placeholders; 1,000 header paths and 2,000 header lines; 2,000 characters per line and per destination once %-encoded; 32 KB of custom headers per response; and whatever fits a deploy's 2 MB index, keeping the first rules.

On private sites the rules are encrypted with everything else and applied in the browser. A redirect to another site never passes on the key in the link. Headers cannot reach the first visit, a hard reload or requests from other sites, which the browser makes without the decrypting service worker, and `Cache-Control` does nothing there. Isolation, content security and framing headers apply to every page after the first load.

<details>
<summary><strong>Use curl, no install needed</strong></summary>

Deploy a single file. The type comes from its filename, as above:

```sh
curl -T page.html https://site.stoff.dev
```

With your key, the deploy is yours, and you can name it, list and remove:

```sh
curl -T page.html -H 'Authorization: Bearer <key before the dot>' 'https://site.stoff.dev/?name=todo'
curl -H 'Authorization: Bearer <key before the dot>' https://site.stoff.dev/list
curl -X DELETE -H 'Authorization: Bearer <key before the dot>' https://site.stoff.dev/deploys/<id>
curl -X DELETE -H 'Authorization: Bearer <key before the dot>' https://site.stoff.dev/names/<name>
```

Add `-H 'Accept: application/json'` to a deploy for JSON. A deploy without a key can't be removed by you; ask through [issues](https://github.com/Stoffbergie/site/issues) if one needs taking down. `curl https://site.stoff.dev` prints the full usage.

</details>

<details>
<summary><strong>Limits</strong></summary>

| Item                     | Limit                |
| ------------------------ | -------------------- |
| Deploy size              | 100 MB               |
| Files per deploy         | 5000                 |
| Names per key            | 20                   |
| Deploys and name changes | 30 per minute per IP |
| Lifetime                 | Until removed        |

</details>

<details>
<summary><strong>How it works</strong></summary>

The CLI packs every file into one upload: a small index of paths, types and offsets, then the bytes. One Cloudflare Worker streams that upload straight into a single R2 object. Serving a file is a lookup in the cached index and a ranged read of that object, so there's nothing to build, copy or propagate.

</details>

<details>
<summary><strong>Develop</strong></summary>

Requires [Vite+](https://viteplus.dev) and Rust.

```sh
vp install
vp dev
cargo run --manifest-path cli/Cargo.toml -- --help
```

Set `SITE_URL=http://localhost:8787` to point the CLI at the local Worker. `vp run check` formats, lints and type-checks both halves, then runs the end-to-end tests with the real Worker and the real CLI.

Pushing to `main` runs the checks, deploys to Cloudflare and smoke-tests production. Pushing a `v*` tag builds the CLI for macOS, Linux and Windows, and the Homebrew tap picks up the new release.

</details>

---

<p align="center">
  <a href="https://site.stoff.dev">site.stoff.dev</a> ·
  <a href="https://github.com/Stoffbergie/site/issues">Report a problem or abuse</a> ·
  <a href="LICENSE">MIT licensed</a>
</p>
