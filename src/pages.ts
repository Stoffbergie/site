import type { PackFile } from "./pack";

const SOURCE_URL = "https://github.com/Stoffbergie/site";
const ISSUES_URL = "https://github.com/Stoffbergie/site/issues";
const TAGLINE = "Static sites, live in one command.";
const HEADLINE = "Put a folder on the web.";

const STYLE = `
:root{--bg:#fafafa;--fg:#171717;--muted:#737373;--line:#e5e5e5;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#ededed;--muted:#8f8f8f;--line:#262626}}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--bg);color:var(--fg);font:14px/1.7 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;-webkit-text-size-adjust:100%}
body{max-width:52rem;margin:0 auto;padding:14vh 1.5rem 6rem}
a{color:inherit;text-decoration-color:var(--muted);text-underline-offset:3px}
header{margin-bottom:3.5rem}
header a{font-weight:600;text-decoration:none}
h1{font-size:1rem;font-weight:600;overflow-wrap:anywhere}
h2{margin:3rem 0 .75rem;color:var(--muted);font-size:.75rem;font-weight:400;letter-spacing:.08em;text-transform:uppercase}
p{color:var(--muted)}
dt,code{font:inherit;overflow-wrap:anywhere;user-select:all}
footer{margin-top:4rem}
.commands{display:grid;grid-template-columns:minmax(0,1fr) 12rem;gap:.8rem 2rem}
.commands dd{margin:0;color:var(--muted)}
details{margin-top:2.5rem}
summary{color:var(--muted);cursor:pointer}
details p{margin-top:2rem}
.files{margin-top:2rem;border-top:1px solid var(--line);list-style:none}
.files li{display:grid;grid-template-columns:minmax(0,1fr) 6rem;gap:1rem;padding:.35rem 0;border-bottom:1px solid var(--line)}
.files a{overflow-wrap:anywhere}
.files span{color:var(--muted);text-align:right}
@media(max-width:600px){.commands{grid-template-columns:1fr;gap:0}.commands dd{margin-bottom:1rem}}
:focus-visible{outline:2px solid var(--fg);outline-offset:3px}
`;

type Row = [command: string, label: string, description: string];
type Section = { title: string; rows: Row[] };

const AUTOMATION_GUIDANCE =
  "Agents and automation: deploy with site --no-copy <folder> and read the URL from stdout. The key in site key owns your deploys and names; never print, log or share it. Remove deploys you made for a one-off task with site rm <id> when the task is done.";

function usage(origin: string, domain: string): Section[] {
  return [
    { title: "Install", rows: [["brew install stoffbergie/tap/site", "", "Install the site CLI with Homebrew on macOS or Linux."]] },
    {
      title: "Use",
      rows: [
        ["site dist", "Deploy a folder", `Upload a folder in one request and print a URL like https://k3m9xq2a.${domain}. Every deploy gets its own URL and never changes.`],
        ["site dist -n todo", "Give it a name", `Also point https://todo.${domain} at this deploy. The first deploy claims the name; later deploys with your key move it.`],
        ["site ls", "Your sites", "List your names, the deploy each points at, and your deploys with their age, size and file count."],
        ["site point todo k3m9xq2a", "Roll back", "Point a name at one of your earlier deploys."],
        ["site rm k3m9xq2a", "Remove", "Delete a deploy, or release a name with site rm todo. A deploy a name points at stays until the name moves."]
      ]
    },
    {
      title: "More",
      rows: [
        ["site index.html style.css", "Loose files", "Deploy files from different places; each lands at the root under its filename."],
        ["cat page.html | site -", "From a pipe", "Deploy stdin as index.html."],
        ["site dist --spa", "Single-page apps", "Serve index.html for unknown paths without a file extension, so client-side routes work."],
        ["site key", "Your key", "Print the key that owns your deploys and names. It is made the first time you deploy and kept on this machine."],
        ["site key <key>", "Another machine", "Save your key on a second machine to deploy, list and remove the same sites from there."]
      ]
    },
    {
      title: "curl",
      rows: [
        [`curl -T page.html ${origin}`, "Deploy one file", "Upload a single file; its type comes from the filename and it is served at / and under its name. Prints the URL."],
        [`curl -T page.html -H 'Authorization: Bearer <key>' '${origin}/?name=todo'`, "Name it", "Deploy with your key to own the deploy and claim or move a name."],
        [`curl -H 'Authorization: Bearer <key>' ${origin}/list`, "List as JSON", "Your names and deploys."],
        [`curl -X DELETE -H 'Authorization: Bearer <key>' ${origin}/deploys/<id>`, "Delete a deploy", "Remove a deploy you own. DELETE /names/<name> releases a name."]
      ]
    }
  ];
}

const LIMITS = `Deploys stay until you remove them. Each deploy holds up to 100 MB and 5000 files; each key holds up to 20 names. Names are 3 to 40 lowercase letters, digits and hyphens. Errors are plain text: 400 bad upload or name, 401 missing key, 403 not yours, 409 name taken, 413 too large, 429 too many requests.`;

export function homeText(origin: string, domain: string): string {
  const lines = [`site: ${TAGLINE.toLowerCase()}`, "", AUTOMATION_GUIDANCE, ""];
  for (const section of usage(origin, domain)) {
    lines.push(section.title.toUpperCase());
    const width = Math.max(...section.rows.map(([command]) => command.length));
    for (const [command, , description] of section.rows) lines.push(`  ${command.padEnd(width)}  # ${description}`);
    lines.push("");
  }
  lines.push(LIMITS, "", `Report abuse or problems: ${ISSUES_URL}`, "");
  return lines.join("\n");
}

export function homePage(origin: string, domain: string): string {
  const sections = usage(origin, domain).map((section) => {
    const rows = section.rows.map(([command, label, description]) => `<dt>${escapeHtml(command)}</dt><dd>${escapeHtml(label)}<span hidden> ${escapeHtml(description)}</span></dd>`).join("");
    return `<h2>${section.title}</h2><dl class="commands">${rows}</dl>`;
  });
  return layout(
    `site · ${HEADLINE}`,
    `<h1>${HEADLINE}</h1>
<p hidden id="automation">${escapeHtml(AUTOMATION_GUIDANCE)}</p>
${sections.slice(0, 2).join("")}
<details><summary>More options</summary>${sections.slice(2).join("")}<p>${escapeHtml(LIMITS)}</p></details>
<footer><p><a href="${SOURCE_URL}">Source</a> · <a href="${ISSUES_URL}">Report abuse or a problem</a></p></footer>
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", name: "site", url: `${origin}/`, description: TAGLINE })}</script>`,
    {
      description: `${TAGLINE} Upload a folder in one request and get a URL. No accounts, no build step.`,
      url: `${origin}/`,
      image: `${origin}/social/site.png`,
      index: true,
      branded: true
    }
  );
}

export function notFoundPage(): string {
  return layout("Not found · site", `<h1>Not found</h1>\n<p>Nothing is here.</p>`, { description: "Nothing is here.", branded: true });
}

export function fileListPage(hostname: string, files: PackFile[]): string {
  const rows = files.map((file) => `<li><a href="/${encodePath(file.path)}">${escapeHtml(file.path)}</a><span>${size(file.length)}</span></li>`).join("");
  return layout(
    hostname,
    `<h1>${escapeHtml(hostname)}</h1>
<p>${files.length} files</p>
<ul class="files">${rows}</ul>`,
    { description: `Files on ${hostname}` }
  );
}

function layout(title: string, body: string, metadata: { description: string; url?: string; image?: string; index?: boolean; branded?: boolean }): string {
  const social =
    metadata.url && metadata.image
      ? `<link rel="canonical" href="${escapeHtml(metadata.url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="site">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(metadata.description)}">
<meta property="og:url" content="${escapeHtml(metadata.url)}">
<meta property="og:image" content="${escapeHtml(metadata.image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(TAGLINE)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(metadata.description)}">
<meta name="twitter:image" content="${escapeHtml(metadata.image)}">`
      : "";
  const icons = metadata.branded ? `<link rel="icon" href="/favicon.png" type="image/png">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">` : "";
  const header = metadata.branded ? `<header><a href="/">site</a></header>` : "";
  return `<!doctype html>
<html lang="en" prefix="og: https://ogp.me/ns#">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(metadata.description)}">
<meta name="robots" content="${metadata.index ? "index, follow" : "noindex, nofollow"}">
${social}
${icons}
<style>${STYLE}</style>
</head>
<body>
${header}
<main>
${body}
</main>
</body>
</html>`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
