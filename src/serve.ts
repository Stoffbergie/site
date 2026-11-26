import type { Env } from "./env";
import { isDeployId, nameProblem } from "./names";
import type { PackFile } from "./pack";
import { fileListPage } from "./pages";
import { deployKey, EDGE_SECONDS, loadDeploy, readPointer, type Deploy } from "./storage";

type Target = { kind: "file"; number: number; status: 200 | 404 } | { kind: "folder" } | { kind: "list" } | { kind: "missing" };
type ByteRange = { offset: number; length: number };

const IMMUTABLE = "public, max-age=31536000, immutable, no-transform";
const REVALIDATE = "no-cache, no-transform";

export async function serveSite(request: Request, env: Env, ctx: ExecutionContext, label: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(`Sites are read-only. Deploy at https://${env.SITE_DOMAIN}\n`, 405, { Allow: "GET, HEAD" });
  }

  let id: string;
  let named: boolean;
  if (isDeployId(label)) {
    id = label;
    named = false;
  } else {
    if (nameProblem(label) !== null) return noSite();
    const pointer = await readPointer(env, label);
    if (!pointer) return noSite();
    id = pointer.id;
    named = true;
  }

  const deploy = await loadDeploy(env, id);
  if (!deploy) return noSite();

  const url = new URL(request.url);
  const pathname = decodePath(url.pathname);
  if (pathname === null) return notFound();
  const target = resolve(deploy, pathname);

  if (target.kind === "missing") return notFound();
  if (target.kind === "folder") return new Response(null, { status: 308, headers: { Location: `${url.pathname}/${url.search}`, "Cache-Control": REVALIDATE } });
  if (target.kind === "list") return listing(request, deploy, named, url.hostname);
  return serveFile(request, env, ctx, deploy, target.number, target.status, named);
}

function resolve(deploy: Deploy, pathname: string): Target {
  const { byPath, index } = deploy;
  const relative = pathname.slice(1);

  const candidates: string[] = [];
  if (relative === "" || relative.endsWith("/")) {
    candidates.push(`${relative}index.html`);
  } else {
    candidates.push(relative, `${relative}.html`);
  }
  for (const candidate of candidates) {
    const number = byPath.get(candidate);
    if (number !== undefined) return { kind: "file", number, status: 200 };
  }
  if (relative !== "" && byPath.has(`${relative}/index.html`)) return { kind: "folder" };

  if (relative === "") {
    if (index.files.length === 1) return { kind: "file", number: 0, status: 200 };
    const pages = index.files.filter((file) => isHtml(file));
    if (pages.length === 1) return { kind: "file", number: index.files.indexOf(pages[0]), status: 200 };
    return { kind: "list" };
  }

  const lastSegment = relative.split("/").pop() ?? "";
  const home = byPath.get("index.html");
  if (index.spa && !lastSegment.includes(".") && home !== undefined) return { kind: "file", number: home, status: 200 };

  const notFoundPage = byPath.get("404.html");
  if (notFoundPage !== undefined) return { kind: "file", number: notFoundPage, status: 404 };
  return { kind: "missing" };
}

async function serveFile(request: Request, env: Env, ctx: ExecutionContext, deploy: Deploy, number: number, status: 200 | 404, named: boolean): Promise<Response> {
  const file = deploy.index.files[number];
  const etag = `"${deploy.id}-${number}"`;
  const headers = contentHeaders(file.type, etag, status, named);
  let clientEncodings = request.headers.get("accept-encoding") ?? "";
  if (typeof request.cf?.clientAcceptEncoding === "string") clientEncodings = request.cf.clientAcceptEncoding;
  const acceptsGzip = /\bgzip\b/.test(clientEncodings);

  if (file.gzip) {
    headers.set("Vary", "Accept-Encoding");
  } else {
    headers.set("Accept-Ranges", "bytes");
  }
  if (status === 200 && sameVersion(request, etag)) return new Response(null, { status: 304, headers });

  const rangeHeader = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const rangeStillValid = ifRange === null || ifRange === etag;
  if (!file.gzip && status === 200 && rangeHeader !== null && rangeStillValid) {
    const range = parseRange(rangeHeader, file.length);
    if (range === null) {
      headers.set("Content-Range", `bytes */${file.length}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${file.length}`);
    headers.set("Content-Length", String(range.length));
    if (request.method === "HEAD") return new Response(null, { status: 206, headers });
    const object = await env.SITES.get(deployKey(deploy.id), { range: { offset: deploy.dataStart + file.offset + range.offset, length: range.length } });
    if (!object) return noSite();
    return new Response(object.body, { status: 206, headers });
  }

  const sendGzipped = file.gzip && acceptsGzip;
  if (sendGzipped) headers.set("Content-Encoding", "gzip");
  if (!file.gzip || sendGzipped) headers.set("Content-Length", String(file.length));
  if (request.method === "HEAD") return new Response(null, { status, headers, encodeBody: "manual" });

  const stored = await storedBytes(env, ctx, deploy, file, number);
  if (!stored) return noSite();
  if (file.gzip && !acceptsGzip) return new Response(stored.pipeThrough(new DecompressionStream("gzip")), { status, headers });
  return new Response(stored, { status, headers, encodeBody: "manual" });
}

async function storedBytes(env: Env, ctx: ExecutionContext, deploy: Deploy, file: PackFile, number: number): Promise<ReadableStream | null> {
  if (file.length === 0) return new Blob([]).stream();
  const cacheKey = new Request(`https://${env.SITE_DOMAIN}/__file/${deploy.id}/${number}`);
  const cached = await caches.default.match(cacheKey);
  if (cached?.body) return cached.body;

  const object = await env.SITES.get(deployKey(deploy.id), { range: { offset: deploy.dataStart + file.offset, length: file.length } });
  if (!object) return null;
  const [forClient, forCache] = object.body.tee();
  const entry = new Response(forCache, { headers: { "Cache-Control": `public, max-age=${EDGE_SECONDS}`, "Content-Length": String(file.length) } });
  ctx.waitUntil(caches.default.put(cacheKey, entry));
  return forClient;
}

function listing(request: Request, deploy: Deploy, named: boolean, hostname: string): Response {
  const etag = `"${deploy.id}-list"`;
  const headers = contentHeaders("text/html; charset=utf-8", etag, 200, named);
  if (sameVersion(request, etag)) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(fileListPage(hostname, deploy.index.files), { headers });
}

function contentHeaders(type: string, etag: string, status: number, named: boolean): Headers {
  let cacheControl = IMMUTABLE;
  if (named || status !== 200) cacheControl = REVALIDATE;
  return new Headers({
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": cacheControl,
    ETag: etag
  });
}

function sameVersion(request: Request, etag: string): boolean {
  const presented = request.headers.get("if-none-match");
  if (presented === null) return false;
  return presented.replace(/^W\//, "") === etag;
}

function parseRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size === 0) return null;
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return null;
  if (startText === "") {
    const suffix = Math.min(Number(endText), size);
    if (suffix === 0) return null;
    return { offset: size - suffix, length: suffix };
  }
  const start = Number(startText);
  let end = size - 1;
  if (endText !== "") end = Math.min(Number(endText), size - 1);
  if (start > end) return null;
  return { offset: start, length: end - start + 1 };
}

function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function isHtml(file: PackFile): boolean {
  return file.type.startsWith("text/html");
}

function noSite(): Response {
  return plain("No site here\n", 404, { "Cache-Control": "no-store" });
}

function notFound(): Response {
  return plain("Not found\n", 404, { "Cache-Control": REVALIDATE });
}

function plain(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*", ...headers } });
}
