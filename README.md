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
| Deploy loose files at the root  | `site index.html style.css`        |
| Deploy command output as a page | `cat page.html \| site -`          |
| A single-page app               | `site dist --spa`                  |
| See your names and deploys      | `site ls`                          |
| Roll a name back                | `site point todo k3m9xq2a`         |
| Remove a deploy or a name       | `site rm k3m9xq2a`, `site rm todo` |

Links go to stdout; details go to stderr. Dotfiles, dot-directories and `node_modules` are left out.

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

A deploy a name points at can't be removed until the name moves or is released with `site rm todo`.

Names are 3 to 40 lowercase letters, digits and hyphens. Each key holds up to 20.

## Your key

There's no login. The first deploy makes a random key on your machine, and that key owns your deploys and names. Only a hash of it reaches the server's storage.

To use the same sites from another machine, print the key on the first and save it on the second:

```sh
site key                 # on the first machine
site key site_…          # on the second
```

`site key <key>` asks before replacing a different key, and refuses in scripts. In CI, set `SITE_KEY` instead.

## What gets served

| Request       | Serves                                     |
| ------------- | ------------------------------------------ |
| `/`           | `index.html`                               |
| `/docs/`      | `docs/index.html`                          |
| `/about`      | `about.html`, then `about/index.html`      |
| Anything else | `404.html` with status 404, or a plain 404 |

With `--spa`, unknown paths without a file extension serve `index.html`. With no `index.html`, a lone HTML file is the page at `/`, a single file is served at `/` and under its name, and anything else shows a file list.

Text files are compressed before upload and served compressed. Other files support byte ranges. Deploy URLs are cached by browsers for a year, since a deploy never changes; named URLs revalidate on every load.

<details>
<summary><strong>Use curl, no install needed</strong></summary>

Deploy a single file. The type comes from its filename:

```sh
curl -T page.html https://site.stoff.dev
```

With your key, the deploy is yours, and you can name it, list and remove:

```sh
curl -T page.html -H 'Authorization: Bearer <key>' 'https://site.stoff.dev/?name=todo'
curl -H 'Authorization: Bearer <key>' https://site.stoff.dev/list
curl -X DELETE -H 'Authorization: Bearer <key>' https://site.stoff.dev/deploys/<id>
curl -X DELETE -H 'Authorization: Bearer <key>' https://site.stoff.dev/names/<name>
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
