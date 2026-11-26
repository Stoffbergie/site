import type { Env } from "./env";
import { randomId } from "./names";
import {
  checkIndex,
  decodeIndex,
  encodeHeader,
  MAX_DEPLOY_BYTES,
  MAX_INDEX_BYTES,
  PACK_MAGIC,
  PREAMBLE_LENGTH,
  readIndexLength,
  StreamTaker,
  startsWithMagic,
  typeFor,
  validPath,
  type PackIndex
} from "./pack";

export const MAX_NAMES = 20;
export const EDGE_SECONDS = 300;
const HEAD_READ_BYTES = 65_536;
const MEMORY_ENTRIES = 500;

export type Deploy = { id: string; index: PackIndex; dataStart: number; byPath: Map<string, number> };
export type Stored = { id: string; files: number; size: number };
export type StoreResult = { stored: Stored } | { problem: string; status: 400 | 411 | 413 };
export type Pointer = { id: string; owner: string; etag: string };

const memory = new Map<string, { deploy: Deploy; loadedAt: number }>();

export function deployKey(id: string): string {
  return `d/${id}`;
}

export function nameKey(name: string): string {
  return `n/${name}`;
}

export function ownedDeployKey(owner: string, id: string): string {
  return `o/${owner}/d/${id}`;
}

export function ownedNameKey(owner: string, name: string): string {
  return `o/${owner}/n/${name}`;
}

export async function storeDeploy(env: Env, request: Request, filename: string, owner: string | null): Promise<StoreResult> {
  const body = await sizedBody(request);
  if ("problem" in body) return body;
  if (body.length > MAX_DEPLOY_BYTES) return tooLarge();

  const taker = new StreamTaker(body.stream.getReader());
  const magic = await taker.take(PACK_MAGIC.byteLength);
  let source: ReadableStream<Uint8Array>;
  let total: number;
  let index: PackIndex;

  if (startsWithMagic(magic)) {
    const lengthBytes = await taker.take(PREAMBLE_LENGTH - PACK_MAGIC.byteLength);
    if (lengthBytes.byteLength < PREAMBLE_LENGTH - PACK_MAGIC.byteLength) return malformed("The pack ends before its index.");
    const preamble = new Uint8Array(PREAMBLE_LENGTH);
    preamble.set(magic, 0);
    preamble.set(lengthBytes, PACK_MAGIC.byteLength);
    const indexLength = readIndexLength(preamble);
    if (indexLength > MAX_INDEX_BYTES) return malformed("The pack index is too large.");
    if (PREAMBLE_LENGTH + indexLength > body.length) return malformed("The pack ends before its index.");
    const json = await taker.take(indexLength);
    const check = checkIndex(json, body.length - PREAMBLE_LENGTH - indexLength);
    if ("problem" in check) return malformed(check.problem);
    index = check.index;
    source = taker.remaining([preamble, json]);
    total = body.length;
  } else {
    const safeName = validPath(filename) && !filename.includes("/") ? filename : "file";
    index = { spa: false, files: [{ path: safeName, offset: 0, length: body.length, type: typeFor(safeName), gzip: false }] };
    const header = encodeHeader(index);
    source = taker.remaining([header, magic]);
    total = header.byteLength + body.length;
  }

  const size = index.files.reduce((sum, file) => sum + file.length, 0);
  const metadata: Record<string, string> = { files: String(index.files.length), size: String(size) };
  if (owner) metadata.owner = owner;

  const id = randomId();
  const fixed = new FixedLengthStream(total);
  const piping = source.pipeTo(fixed.writable);
  let written: R2Object | null;
  try {
    [written] = await Promise.all([env.SITES.put(deployKey(id), fixed.readable, { customMetadata: metadata, onlyIf: new Headers({ "if-none-match": "*" }) }), piping]);
  } catch {
    return malformed("The upload was shorter or longer than it said; deploy again.");
  }
  if (!written) throw new Error(`Deploy id ${id} was already taken`);
  if (owner) await env.SITES.put(ownedDeployKey(owner, id), "", { customMetadata: { files: metadata.files, size: metadata.size } });
  return { stored: { id, files: index.files.length, size } };
}

export async function removeDeploy(env: Env, id: string, owner: string | undefined): Promise<void> {
  const keys = [deployKey(id)];
  if (owner) keys.push(ownedDeployKey(owner, id));
  await env.SITES.delete(keys);
  memory.delete(id);
}

export async function loadDeploy(env: Env, id: string): Promise<Deploy | null> {
  const remembered = memory.get(id);
  if (remembered && Date.now() - remembered.loadedAt < EDGE_SECONDS * 1000) return remembered.deploy;

  const cacheKey = new Request(`https://${env.SITE_DOMAIN}/__index/${id}`);
  const cached = await caches.default.match(cacheKey);
  let header: Uint8Array | null = null;
  if (cached) header = new Uint8Array(await cached.arrayBuffer());
  if (!header) {
    header = await readHeader(env, id);
    if (!header) return null;
    await caches.default.put(cacheKey, new Response(header, { headers: { "Cache-Control": `public, max-age=${EDGE_SECONDS}` } }));
  }

  const index = decodeIndex(header.subarray(PREAMBLE_LENGTH));
  const byPath = new Map(index.files.map((file, position) => [file.path, position]));
  const deploy = { id, index, dataStart: header.byteLength, byPath };
  remember(id, deploy);
  return deploy;
}

async function readHeader(env: Env, id: string): Promise<Uint8Array | null> {
  const start = await env.SITES.get(deployKey(id), { range: { offset: 0, length: HEAD_READ_BYTES } });
  if (!start) return null;
  const bytes = new Uint8Array(await start.arrayBuffer());
  const headerLength = PREAMBLE_LENGTH + readIndexLength(bytes);
  if (headerLength <= bytes.byteLength) return bytes.slice(0, headerLength);
  const whole = await env.SITES.get(deployKey(id), { range: { offset: 0, length: headerLength } });
  if (!whole) return null;
  return new Uint8Array(await whole.arrayBuffer());
}

function remember(id: string, deploy: Deploy): void {
  memory.delete(id);
  memory.set(id, { deploy, loadedAt: Date.now() });
  if (memory.size > MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value as string;
    memory.delete(oldest);
  }
}

export async function readPointer(env: Env, name: string): Promise<Pointer | null> {
  const object = await env.SITES.head(nameKey(name));
  if (!object) return null;
  const id = object.customMetadata?.id ?? "";
  const owner = object.customMetadata?.owner ?? "";
  return { id, owner, etag: object.etag };
}

export async function writePointer(env: Env, name: string, owner: string, id: string, previousEtag: string | null): Promise<boolean> {
  let onlyIf: R2Conditional | Headers;
  if (previousEtag === null) {
    onlyIf = new Headers({ "if-none-match": "*" });
  } else {
    onlyIf = { etagMatches: previousEtag };
  }
  const written = await env.SITES.put(nameKey(name), "", { customMetadata: { id, owner }, onlyIf });
  if (!written) return false;
  if (previousEtag === null) await env.SITES.put(ownedNameKey(owner, name), "");
  return true;
}

export async function removePointer(env: Env, name: string, owner: string): Promise<void> {
  await env.SITES.delete([nameKey(name), ownedNameKey(owner, name)]);
}

export async function ownedNames(env: Env, owner: string): Promise<string[]> {
  const prefix = ownedNameKey(owner, "");
  const listed = await env.SITES.list({ prefix, limit: 1000 });
  return listed.objects.map((object) => object.key.slice(prefix.length));
}

export async function ownedDeploys(env: Env, owner: string): Promise<R2Object[]> {
  const listed = await env.SITES.list({ prefix: ownedDeployKey(owner, ""), limit: 1000, include: ["customMetadata"] });
  return listed.objects;
}

export async function namesPointingAt(env: Env, owner: string, id: string): Promise<string[]> {
  const names = await ownedNames(env, owner);
  const pointers = await Promise.all(names.map((name) => readPointer(env, name)));
  return names.filter((_, position) => pointers[position]?.id === id);
}

async function sizedBody(request: Request): Promise<{ stream: ReadableStream<Uint8Array>; length: number } | { problem: string; status: 411 | 413 }> {
  const declared = request.headers.get("content-length");
  if (declared !== null && request.body) {
    const length = Number(declared);
    if (length > MAX_DEPLOY_BYTES) return tooLarge();
    return { stream: request.body, length };
  }
  const buffered = new Uint8Array(await request.arrayBuffer());
  if (buffered.byteLength === 0) return { problem: "Send a file or a pack to deploy.", status: 411 };
  if (buffered.byteLength > MAX_DEPLOY_BYTES) return tooLarge();
  return { stream: new Blob([buffered]).stream(), length: buffered.byteLength };
}

function tooLarge(): { problem: string; status: 413 } {
  return { problem: "Deploys are limited to 100 MB; leave out large files or host them elsewhere.", status: 413 };
}

function malformed(problem: string): { problem: string; status: 400 } {
  return { problem, status: 400 };
}
