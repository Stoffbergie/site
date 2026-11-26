---
name: site
description: Deploys static files to a live URL with the site CLI, including naming a site, redeploying, rolling back and removing deploys. Use when a request involves site.stoff.dev, publishing a built folder, an HTML page or a preview link for static files. Not for developing, deploying, or releasing the site repository.
---

# Site

Produce a working URL for static files. Deploys made with a key stay until removed; there are no accounts. A key on the machine owns deploys and names.

## Choose what to deploy

- Deploy the built output the request is about (`dist`, `build`, `public`, a single page), not the source tree. Build first if the request implies it; site does not build anything.
- One folder deploys its contents as the site root. Several files each land at the root under their filename; a folder cannot be mixed with files. `-` deploys stdin as `index.html`. Names starting with a dot stay private (`.env`, `.git`, `.npmrc`, editor folders) except `.well-known/`, which deploys with JSON, JRD and XRD types for its extensionless files; the CLI names what it left out on stderr. Symlinks and `node_modules` are skipped. Private sites serve `.well-known/` only inside the browser, so use a public deploy for files that apps or certificate authorities fetch.
- Files in any text encoding work as they are; do not convert legacy-encoded pages to UTF-8 before deploying.
- Files get their standard content type from the extension, as on other static hosts, so feeds, modules, `.wasm`, media and downloads work without configuration. Files with an unknown extension or none (`LICENSE`, `CNAME`) are plain text if they look like text and a download otherwise; an HTML page needs a `.html` name to render.
- Compressed build output works as on any well-configured server: a `.gz`, `.br` or `.unityweb` file a page loads directly (`.js`, `.mjs`, `.wasm`, `.css`, `.html`, `.svg`, `.data`, `.pck`, `.mem`, `.symbols.json` under the suffix, as Unity, Emscripten and Godot write) is served decoded with the inner file's type, so `game.wasm.gz` streams as `application/wasm`. One that unpacks to more than 100 MB fails the deploy. Any other `.gz` or `.br`, such as `backup.tar.gz` or `data.csv.gz`, arrives byte for byte as the compressed file. A `.gz` or `.br` copy next to a file holding the same content (from compression plugins or `gzip_static` setups) is left out, since site compresses the original itself. A page that needs `app.js.gz` itself as a download must not also ship an identical `app.js`.
- Deploy build output as it is: clean URLs, `.htm`, trailing slashes, `404.html`, `200.html`, letter-case differences and assets built for a base path all work. A single-page app whose only HTML or XHTML page is `index.html` and that has no `404.html` gets `index.html` on its routes without a flag; pass `--spa` when it also ships other HTML pages or a `404.html`. A `/* /index.html 200` line in `_redirects` does the same as `--spa`.
- Every site has a tab icon: its own `favicon.ico` or `favicon.png`/`.svg`, `icon.png`/`.svg`, `apple-touch-icon.png` from the top folder, else one drawn for it. Add no placeholder favicon to stop a 404.
- `_redirects` and `_headers` at the root of the folder are applied as on Netlify and Cloudflare Pages, on public and encrypted sites, and are never served. A rule without `!` gives way to a page that exists under any of the names above (`.html`, a folder index, another letter case); explicit rules win over `200.html`, the single-page-app fallback and base-path assets. Read the stderr notes after a deploy: lines that need a server (proxying to another site, country, language, role or cookie conditions, query-parameter matching, other domains) headers site keeps fixed (`Set-Cookie`, `Clear-Site-Data`, `ETag`, `X-Content-Type-Options` and the like), redirect loops and rules past the 2 MB index are skipped and listed there. On named URLs a `Cache-Control` without its own `no-cache` or `no-store` directive is not used, so redeploys always show. A `404` rewrite never falls back to the `--spa` app shell.
- Pass `-e` when the content is private or the user asks for it. The site is encrypted on this machine and only the full link, including the key after `#`, opens it, in a browser with JavaScript. The link is the secret: report it only to the user and never log it elsewhere.
- Pass `--no-copy` on every deploy, including in terminals and pseudo-terminals, unless the user explicitly asks to copy the link.
- Check `command -v site` and `site --help`. If absent, install with `brew install stoffbergie/tap/site` where Homebrew is available, or use a binary from [official releases](https://github.com/Stoffbergie/site/releases).
- The default server is `https://site.stoff.dev`. Preserve an existing `SITE_URL` and `SITE_KEY`.

## Deploy

```sh
site --no-copy dist
site --no-copy dist -n todo
site --no-copy index.html style.css
make report | site --no-copy -
```

Capture the link when another command needs it:

```sh
url=$(site --no-copy dist)
```

Check the exit status before using the result. Stdout holds one link; details go to stderr. With `-n`, stdout is the named URL and the deploy's own URL is on stderr. With `-e`, every link ends in `/#<key>`; keep the whole link.

Everything goes up in one request and is live when the link prints. The CLI refuses deploys over 100 MB or 5000 files before uploading; leave out large files rather than retrying.

## Names

`-n todo` points `https://todo.site.stoff.dev` at the new deploy. The first use claims the name for this machine's key; later deploys with the same key move it, and the change is visible on the next load. "That name is taken" means another key owns it: pick another name, do not retry. A name holding an encrypted site refuses a deploy without `-e`; add `-e`, or release the name only if the user wants it public. With `-e -n`, the link stays the same across redeploys. Use a name only when the user wants a stable URL; one-off previews need no name. Every deploy gets a new address, and browsers keep storage, sign-ins and service workers per address, so an app people sign into, install or keep data in needs a name. Sites send open CORS headers and answer preflights, so other origins can load their files.

Names are 3 to 40 lowercase letters, digits and hyphens. Reserved words and brand or credential words (bank, login, paypal and similar) are refused anywhere in the name.

## List, roll back and remove

```sh
site ls
site point todo k3m9xq2a
site rm k3m9xq2a
site rm todo
```

`site point` moves a name to one of your earlier deploys; an encrypted name only moves to deploys encrypted for that name. `site ls` prints full links, keys included, for encrypted deploys. `site rm` deletes a deploy, or releases a name; a deploy a name points at is refused until the name moves. Remove deploys you made for a one-off task or for verification when done. Do not remove deploys or names the request does not cover.

A removed deploy may keep serving from the edge cache for up to 5 minutes. A released name stops at once.

## Keys

`site key` prints the key that owns this machine's deploys and names. Never print, log or share it unless the user asks to move it to another machine. `site key <key>` saves a key from another machine; it refuses to replace a different key without a terminal confirmation. Do not delete the config file to force a replacement: the old key's sites would become unmanageable from here. In CI, set `SITE_KEY` instead of saving a key.

## Verify and recover

- Fetch the printed URL (and a page or asset that matters) and check the status and content before reporting it works. A printed link alone does not prove the right files went up. An encrypted site is only readable in a browser with the full link; plain fetches get a private page, so check it in a browser or report that only the deploy was verified.
- For a named redeploy, fetch the named URL and confirm the new content; it is never stale.
- If a deploy fails, nothing was stored. Fix the cause the error names and deploy again.

Report the URL, what was actually verified, and any remaining blocker.
