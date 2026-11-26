import bootSource from "virtual:browser/boot";
import serviceWorkerSource from "virtual:browser/service-worker";
import { keepSiteDecisions, READ_METHODS } from "./cors";
import type { Env } from "./env";
import { isDeployId, nameProblem } from "./names";
import type { PackFile } from "./pack";
import { fileListPage, privateSitePage } from "./pages";
import { decodePath, isReserved, parseRange, redirectLocation } from "./resolve";
import { applyHeaderRules, isConfigFile, route } from "./rules";
import { deployKey, EDGE_SECONDS, loadDeploy, readPointer, type Deploy } from "./storage";

const ENTRY_PATH = /^\/__site\/entries\/(0|[1-9]\d*)$/;

const IMMUTABLE = "public, max-age=31536000, immutable, no-transform";
const REVALIDATE = "no-cache, no-transform";
const SMALL_FILE_BYTES = 65_536;
const FILE_MEMORY_BYTES = 16_000_000;
const NEIGHBORHOOD_BYTES = 1_048_576;
const NEIGHBORS_PER_READ = 32;

const fileMemory = new Map<string, { bytes: Uint8Array; loadedAt: number }>();
let fileMemoryBytes = 0;

export async function serveSite(request: Request, env: Env, ctx: ExecutionContext, label: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(`Sites are read-only. Deploy at https://${env.SITE_DOMAIN}\n`, 405, { Allow: READ_METHODS });
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
  if (deploy.index.encrypted) return serveEncrypted(request, env, ctx, deploy, named, url.pathname);
  const pathname = decodePath(url.pathname);
  if (pathname === null) return notFound();
  if (isReserved(pathname)) return notFound();
  const listed = { spa: deploy.index.spa, files: deploy.index.files, byPath: deploy.byPath };
  const routed = route(listed, deploy.index.rules, pathname, url, { privateSite: false });
  if (routed.kind === "redirect") return new Response(null, { status: routed.status, headers: { Location: routed.location, "Cache-Control": REVALIDATE } });
  const target = routed.target;

  if (target.kind === "redirect") {
    const location = redirectLocation(target.path, url);
    if (location !== null) return new Response(null, { status: 308, headers: { Location: location, "Cache-Control": REVALIDATE } });
  }
  let response: Response;
  if (target.kind === "file") {
    response = await serveFile(request, env, ctx, deploy, target.number, target.status, named);
  } else if (target.kind === "list") {
    response = listing(request, deploy, named, url.hostname);
  } else {
    response = notFound();
  }
  keepSiteDecisions(response, applyHeaderRules(response.headers, deploy.index.rules, pathname, named));
  return response;
}

async function serveEncrypted(request: Request, env: Env, ctx: ExecutionContext, deploy: Deploy, named: boolean, pathname: string): Promise<Response> {
  if (pathname === "/__site/sw.js") return script(serviceWorkerSource, { "Service-Worker-Allowed": "/" });
  if (pathname === "/__site/boot.js") return script(bootSource, {});
  if (pathname === "/__site/meta") {
    const entries = deploy.index.files.map((file) => file.length);
    return Response.json({ id: deploy.id, encrypted: deploy.index.encrypted, entries }, { headers: { "Cache-Control": REVALIDATE, "X-Content-Type-Options": "nosniff" } });
  }
  const entry = ENTRY_PATH.exec(pathname);
  if (entry !== null) {
    const number = Number(entry[1]);
    if (number >= deploy.index.files.length) return notFound();
    return serveFile(request, env, ctx, deploy, number, 200, named);
  }
  return new Response(privateSitePage(), {
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": REVALIDATE, "Referrer-Policy": "no-referrer", "X-Site-Bootstrap": "1" }
  });
}

function script(source: string, extraHeaders: Record<string, string>): Response {
  return new Response(source, { headers: { "Content-Type": "text/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": REVALIDATE, ...extraHeaders } });
}

async function serveFile(request: Request, env: Env, ctx: ExecutionContext, deploy: Deploy, number: number, status: 200 | 404, named: boolean): Promise<Response> {
  const file = deploy.index.files[number];
  const etag = `"${file.origin ?? `${deploy.id}-${number}`}"`;
  const headers = contentHeaders(file.type, etag, status, named);
  let clientEncodings = request.headers.get("accept-encoding") ?? "";
  if (typeof request.cf?.clientAcceptEncoding === "string") clientEncodings = request.cf.clientAcceptEncoding;
  const encoding = storedEncoding(file);
  const clientAccepts = encoding !== null && acceptsEncoding(clientEncodings, encoding);

  if (encoding !== null) {
    headers.set("Vary", "Accept-Encoding");
  } else {
    headers.set("Accept-Ranges", "bytes");
  }
  if (status === 200 && sameVersion(request, etag)) return new Response(null, { status: 304, headers });

  const rangeHeader = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const rangeStillValid = ifRange === null || ifRange === etag;
  if (encoding === null && status === 200 && rangeHeader !== null && rangeStillValid) {
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

  if (encoding !== null && clientAccepts) headers.set("Content-Encoding", encoding);
  if (encoding === null || clientAccepts) headers.set("Content-Length", String(file.length));
  if (request.method === "HEAD") return new Response(null, { status, headers, encodeBody: "manual" });

  const stored = await storedBytes(env, ctx, deploy, file, number);
  if (!stored) return noSite();
  if (encoding !== null && !clientAccepts) return new Response(stored.pipeThrough(new DecompressionStream(decompressionFormat(encoding))), { status, headers });
  return new Response(stored, { status, headers, encodeBody: "manual" });
}

async function storedBytes(env: Env, ctx: ExecutionContext, deploy: Deploy, file: PackFile, number: number): Promise<ReadableStream | null> {
  if (file.length === 0) return new Blob([]).stream();
  const small = file.length <= SMALL_FILE_BYTES;
  const memoryKey = `${deploy.id}/${number}`;
  const remembered = fileMemory.get(memoryKey);
  if (remembered && Date.now() - remembered.loadedAt < EDGE_SECONDS * 1000) return new Blob([remembered.bytes]).stream();
  const cacheKey = new Request(`https://${env.SITE_DOMAIN}/__file/${deploy.id}/${number}`);
  const cached = await caches.default.match(cacheKey);
  if (cached?.body && small) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    rememberFile(memoryKey, bytes);
    return new Blob([bytes]).stream();
  }
  if (cached?.body) return cached.body;

  if (small) {
    const bytes = await readNeighborhood(env, ctx, deploy, number);
    if (!bytes) return null;
    return new Blob([bytes]).stream();
  }
  const object = await env.SITES.get(deployKey(deploy.id), { range: { offset: deploy.dataStart + file.offset, length: file.length } });
  if (!object) return null;
  const [forClient, forCache] = object.body.tee();
  const entry = new Response(forCache, { headers: { "Cache-Control": `public, max-age=${EDGE_SECONDS}`, "Content-Length": String(file.length) } });
  ctx.waitUntil(caches.default.put(cacheKey, entry));
  return forClient;
}

async function readNeighborhood(env: Env, ctx: ExecutionContext, deploy: Deploy, number: number): Promise<Uint8Array | null> {
  const files = deploy.index.files;
  const start = files[number].offset;
  const neighbors: number[] = [];
  for (let next = number; next < files.length && neighbors.length < NEIGHBORS_PER_READ; next += 1) {
    const candidate = files[next];
    if (candidate.offset + candidate.length - start > NEIGHBORHOOD_BYTES) break;
    if (candidate.length > 0 && candidate.length <= SMALL_FILE_BYTES) neighbors.push(next);
  }
  const last = files[neighbors[neighbors.length - 1]];
  const object = await env.SITES.get(deployKey(deploy.id), { range: { offset: deploy.dataStart + start, length: last.offset + last.length - start } });
  if (!object) return null;
  const window = new Uint8Array(await object.arrayBuffer());
  const puts: Promise<void>[] = [];
  for (const neighbor of neighbors) {
    const file = files[neighbor];
    const bytes = window.slice(file.offset - start, file.offset - start + file.length);
    rememberFile(`${deploy.id}/${neighbor}`, bytes);
    const cacheKey = new Request(`https://${env.SITE_DOMAIN}/__file/${deploy.id}/${neighbor}`);
    puts.push(caches.default.put(cacheKey, new Response(bytes, { headers: { "Cache-Control": `public, max-age=${EDGE_SECONDS}` } })));
  }
  ctx.waitUntil(Promise.all(puts));
  return window.slice(0, files[number].length);
}

function rememberFile(key: string, bytes: Uint8Array): void {
  const previous = fileMemory.get(key);
  if (previous) fileMemoryBytes -= previous.bytes.byteLength;
  fileMemory.delete(key);
  fileMemory.set(key, { bytes, loadedAt: Date.now() });
  fileMemoryBytes += bytes.byteLength;
  while (fileMemoryBytes > FILE_MEMORY_BYTES) {
    const [oldestKey, oldest] = fileMemory.entries().next().value as [string, { bytes: Uint8Array }];
    fileMemory.delete(oldestKey);
    fileMemoryBytes -= oldest.bytes.byteLength;
  }
}

function listing(request: Request, deploy: Deploy, named: boolean, hostname: string): Response {
  const etag = `"${deploy.id}-list"`;
  const headers = contentHeaders("text/html; charset=utf-8", etag, 200, named);
  if (sameVersion(request, etag)) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") return new Response(null, { headers });
  const listed = deploy.index.files.filter((file) => !isConfigFile(file.path));
  return new Response(fileListPage(hostname, listed), { headers });
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

function storedEncoding(file: PackFile): "br" | "gzip" | null {
  if (file.br) return "br";
  if (file.gzip) return "gzip";
  return null;
}

function decompressionFormat(encoding: "br" | "gzip"): "brotli" | "gzip" {
  if (encoding === "br") return "brotli";
  return "gzip";
}

function acceptsEncoding(clientEncodings: string, encoding: string): boolean {
  return clientEncodings.split(",").some((part) => {
    const [token, ...parameters] = part.toLowerCase().split(";");
    const refused = parameters.some((parameter) => /^\s*q=0(\.0*)?\s*$/.test(parameter));
    return token.trim() === encoding && !refused;
  });
}

function sameVersion(request: Request, etag: string): boolean {
  const presented = request.headers.get("if-none-match");
  if (presented === null) return false;
  return presented.replace(/^W\//, "") === etag;
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
