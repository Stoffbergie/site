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
- To take access away, remove the deploy with `site rm`, or release the name. There is no other revocation.
- A name holding an encrypted site never turns public by accident: deploying to it without `-e` is refused.
- It needs JavaScript and service workers, so it opens in current browsers but not in private windows that turn service workers off. Encrypting needs the CLI; there is no encrypted deploy through curl.

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

| Request       | Serves                                     |
| ------------- | ------------------------------------------ |
| `/`           | `index.html`                               |
| `/docs/`      | `docs/index.html`                          |
| `/about`      | `about.html`, or a redirect to `/about/`   |
| Anything else | `404.html` with status 404, or a plain 404 |

Encrypted sites follow the same rules, applied in the browser. With `--spa`, unknown paths without a file extension serve `index.html`. With no `index.html`, a lone HTML file is the page at `/`, a single file is served at `/` and under its name, and anything else shows a file list.

Every file is served with its standard content type, taken from its extension: the same table as the `mime` and `mime-db` packages that Cloudflare and GitHub Pages use, so feeds, manifests, source maps, modules, fonts, media, HLS and DASH streams, captions, 3D models, `.wasm` and documents behave as they do elsewhere. Files with an unknown extension or none, like `LICENSE` or `CNAME`, are served as UTF-8 plain text when they look like text and as `application/octet-stream`, a download, when they do not. Nothing is ever sniffed into HTML or script.

Text files are compressed before upload and served compressed. Other files support byte ranges. Compressed build output works as on any well-configured server: a `.gz`, `.br` or `.unityweb` file a page loads directly (`.js`, `.mjs`, `.wasm`, `.css`, `.html`, `.svg`, `.data`, `.pck`, `.mem`, `.symbols.json` under the suffix, as Unity, Emscripten and Godot write) is served decoded with the inner file's type, so `game.wasm.gz` streams as `application/wasm`. One that unpacks to more than 100 MB fails the deploy. Any other `.gz` or `.br`, such as `backup.tar.gz` or `data.csv.gz`, arrives byte for byte as the compressed file. A `.gz` or `.br` copy next to a file holding the same content (from compression plugins or `gzip_static` setups) is left out, since site compresses the original itself. Deploy URLs are cached by browsers for a year, since a deploy never changes; named URLs revalidate on every load.

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
