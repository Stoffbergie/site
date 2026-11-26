import { fileListPage } from "../pages";
import { decodePath, isReserved, parseRange, redirectLocation, resolve, type ByteRange, type Target } from "../resolve";
import { CHUNK_SIZE, chunkCount, fetchEntry, fetchMeta, NotPrivate, openChunk, openDeploy, readKey, SEALED_CHUNK_SIZE, TAG_SIZE, WrongKey, type Meta, type Site } from "./site";

type ExtendableEvent = Event & { waitUntil(promise: Promise<unknown>): void };
type FetchEvent = ExtendableEvent & { readonly request: Request; respondWith(response: Promise<Response>): void };
type MessageEvent = ExtendableEvent & { readonly data: unknown };
type ServiceWorkerScope = {
  readonly location: Location;
  readonly clients: { claim(): Promise<void> };
  readonly registration: { unregister(): Promise<boolean> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
};

const worker = self as unknown as ServiceWorkerScope;

type Opened = { kind: "site"; site: Site } | { kind: "public" } | { kind: "locked" };

const BOOTSTRAP_PATH = "/";
const NETWORK_PATH = /^\/__site\/(?:meta|boot\.js|entries\/(?:0|[1-9]\d*))$/;

let current: Site | null = null;

worker.addEventListener("install", () => {
  void worker.skipWaiting();
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(worker.clients.claim());
});

worker.addEventListener("message", (event) => {
  if (event.data === "claim") event.waitUntil(worker.clients.claim());
});

worker.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin) return;
  if (NETWORK_PATH.test(url.pathname)) {
    event.respondWith(fetch(request, { referrerPolicy: "no-referrer" }));
    return;
  }
  const pathname = decodePath(url.pathname);
  if (pathname === null || isReserved(pathname)) {
    event.respondWith(Promise.resolve(notFound()));
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") return;
  event.respondWith(answer(request, url));
});

async function answer(request: Request, url: URL): Promise<Response> {
  let opened: Opened;
  try {
    opened = await openFor(request.mode === "navigate");
  } catch {
    return unavailable();
  }
  if (opened.kind === "public") return fetch(request);
  if (opened.kind === "locked") {
    if (request.mode === "navigate") return fetch(BOOTSTRAP_PATH, { cache: "no-store" });
    return unavailable();
  }

  const site = opened.site;
  const pathname = decodePath(url.pathname);
  if (pathname === null) return notFound();
  const target = resolve(site, pathname);
  if (target.kind === "redirect") {
    const location = redirectLocation(target.path, url);
    if (location === null) return notFound();
    return new Response(null, { status: 308, headers: { Location: location } });
  }
  if (request.mode === "navigate" && !cameFromThisSite(request)) return bootstrapPage(statusOf(target));
  if (target.kind === "missing") return notFound();
  if (target.kind === "list") return html(fileListPage(url.hostname, site.files));
  return serveFile(request, site, target.number, target.status);
}

function statusOf(target: Target): number {
  if (target.kind === "missing") return 404;
  if (target.kind === "file") return target.status;
  return 200;
}

async function bootstrapPage(status: number): Promise<Response> {
  const page = await fetch(BOOTSTRAP_PATH, { cache: "no-store" });
  return new Response(page.body, { status, headers: page.headers });
}

function cameFromThisSite(request: Request): boolean {
  if (request.referrer === "") return false;
  return new URL(request.referrer).origin === worker.location.origin;
}

async function openFor(navigating: boolean): Promise<Opened> {
  if (current !== null && !navigating) return { kind: "site", site: current };
  let meta: Meta;
  try {
    meta = await fetchMeta();
  } catch (error) {
    if (error instanceof NotPrivate) {
      current = null;
      await worker.registration.unregister();
      return { kind: "public" };
    }
    throw error;
  }
  const key = await readKey();
  if (key === null) return { kind: "locked" };
  if (current !== null && current.id === meta.id && current.key === key) return { kind: "site", site: current };
  try {
    current = await openDeploy(meta, key);
  } catch (error) {
    current = null;
    if (error instanceof WrongKey) return { kind: "locked" };
    throw error;
  }
  return { kind: "site", site: current };
}

async function serveFile(request: Request, site: Site, number: number, status: 200 | 404): Promise<Response> {
  const file = site.files[number];
  const headers = new Headers({ "Content-Type": file.type, "X-Content-Type-Options": "nosniff" });

  if (file.gzip) {
    if (request.method === "HEAD") return new Response(null, { status, headers });
    const plain = decryptChunks(site, number, 0, chunkCount(file.length) - 1);
    return new Response(plain.pipeThrough(new DecompressionStream("gzip")), { status, headers });
  }

  headers.set("Accept-Ranges", "bytes");
  const rangeHeader = request.headers.get("range");
  if (status === 200 && rangeHeader !== null) {
    const range = parseRange(rangeHeader, file.length);
    if (range === null) {
      headers.set("Content-Range", `bytes */${file.length}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${file.length}`);
    headers.set("Content-Length", String(range.length));
    if (request.method === "HEAD") return new Response(null, { status: 206, headers });
    return new Response(rangeOf(site, number, range), { status: 206, headers });
  }

  headers.set("Content-Length", String(file.length));
  if (request.method === "HEAD") return new Response(null, { status, headers });
  return new Response(decryptChunks(site, number, 0, chunkCount(file.length) - 1), { status, headers });
}

function rangeOf(site: Site, number: number, range: ByteRange): ReadableStream<Uint8Array<ArrayBuffer>> {
  const firstChunk = Math.floor(range.offset / CHUNK_SIZE);
  const lastChunk = Math.floor((range.offset + range.length - 1) / CHUNK_SIZE);
  let skip = range.offset - firstChunk * CHUNK_SIZE;
  let left = range.length;
  const trim = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      const start = Math.min(skip, chunk.byteLength);
      skip -= start;
      const end = Math.min(chunk.byteLength, start + left);
      left -= end - start;
      if (end > start) controller.enqueue(chunk.subarray(start, end));
    }
  });
  return decryptChunks(site, number, firstChunk, lastChunk).pipeThrough(trim);
}

function decryptChunks(site: Site, number: number, firstChunk: number, lastChunk: number): ReadableStream<Uint8Array<ArrayBuffer>> {
  const entry = number + 1;
  const length = site.files[number].length;
  const finalChunk = chunkCount(length) - 1;
  const sealedLength = length + (finalChunk + 1) * TAG_SIZE;
  let range: { start: number; end: number } | null = null;
  if (firstChunk !== 0 || lastChunk !== finalChunk) {
    range = { start: firstChunk * SEALED_CHUNK_SIZE, end: Math.min((lastChunk + 1) * SEALED_CHUNK_SIZE, sealedLength) - 1 };
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let pieces: Uint8Array[] = [];
  let buffered = 0;
  let chunk = firstChunk;

  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      if (reader === null) {
        const response = await fetchEntry(site.id, entry, range);
        if (response.body === null) throw new Error("The site sent no data.");
        reader = response.body.getReader();
      }
      const wanted = Math.min(SEALED_CHUNK_SIZE, sealedLength - chunk * SEALED_CHUNK_SIZE);
      while (buffered < wanted) {
        const { done, value } = await reader.read();
        if (done) throw new Error("The site ended early; reload the page.");
        pieces.push(value);
        buffered += value.byteLength;
      }
      const joined = join(pieces, buffered);
      const sealed = joined.slice(0, wanted);
      pieces = [joined.subarray(wanted)];
      buffered -= wanted;
      controller.enqueue(await openChunk(site.contentKey, entry, chunk, chunk === finalChunk, sealed));
      chunk += 1;
      if (chunk > lastChunk) {
        await reader.cancel();
        controller.close();
      }
    },
    async cancel(reason) {
      if (reader !== null) await reader.cancel(reason);
    }
  });
}

function join(pieces: Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(total);
  let position = 0;
  for (const piece of pieces) {
    joined.set(piece, position);
    position += piece.byteLength;
  }
  return joined;
}

function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function unavailable(): Response {
  return new Response("Could not load this site; reload the page.\n", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function notFound(): Response {
  return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
