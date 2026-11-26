import { byPathOf, type ListedFile, type Listing } from "../resolve";

export const CHUNK_SIZE = 1024 * 1024;
export const TAG_SIZE = 16;
export const SEALED_CHUNK_SIZE = CHUNK_SIZE + TAG_SIZE;
const CONTENT_INFO = new TextEncoder().encode("site content v1");
const DATABASE = "site";
const STORE = "keys";
const KEY_ENTRY = "link";

export type SealedFile = ListedFile & { gzip: boolean };
export type Site = Listing & { id: string; key: string; files: SealedFile[]; contentKey: CryptoKey };
export type Meta = { id: string; encrypted: { contentSalt: string }; entries: number[] };

export class WrongKey extends Error {}

export async function fetchMeta(): Promise<Meta> {
  const response = await fetch("/__site/meta", { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load the site: ${response.status}`);
  return (await response.json()) as Meta;
}

export async function openDeploy(meta: Meta, key: string): Promise<Site> {
  const linkKey = fromBase64Url(key);
  if (linkKey === null || linkKey.byteLength !== 32) throw new WrongKey();
  const contentKey = await deriveContentKey(linkKey, fromBase64Url(meta.encrypted.contentSalt) ?? new Uint8Array());
  const indexLength = meta.entries[0];
  const sealedIndex = new Uint8Array(await (await fetchEntry(meta.id, 0, null)).arrayBuffer());
  if (sealedIndex.byteLength !== indexLength) throw new Error("The site changed while opening it.");
  let plainIndex: Uint8Array;
  try {
    plainIndex = await openWhole(contentKey, 0, sealedIndex, plainLength(indexLength));
  } catch {
    throw new WrongKey();
  }
  const index = JSON.parse(new TextDecoder().decode(plainIndex)) as { spa: boolean; files: SealedFile[] };
  return { id: meta.id, key, spa: index.spa, files: index.files, byPath: byPathOf(index.files), contentKey };
}

async function deriveContentKey(linkKey: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", linkKey, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: CONTENT_INFO }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

export function fetchEntry(id: string, entry: number, range: { start: number; end: number } | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (range !== null) headers.Range = `bytes=${range.start}-${range.end}`;
  return fetch(`/__site/entries/${entry}`, { headers }).then((response) => {
    const etag = (response.headers.get("etag") ?? "").replace(/^W\//, "");
    if (!response.ok || etag !== `"${id}-${entry}"`) throw new Error("The site changed while loading it; reload the page.");
    return response;
  });
}

export function chunkCount(length: number): number {
  return Math.max(1, Math.ceil(length / CHUNK_SIZE));
}

function plainLength(sealedLength: number): number {
  return sealedLength - Math.ceil(sealedLength / SEALED_CHUNK_SIZE) * TAG_SIZE;
}

export function nonce(entry: number, chunk: number, final: boolean): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, entry);
  view.setUint32(4, chunk);
  if (final) bytes[11] = 1;
  return bytes;
}

export async function openChunk(contentKey: CryptoKey, entry: number, chunk: number, final: boolean, sealed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(entry, chunk, final) }, contentKey, sealed);
  return new Uint8Array(plain);
}

async function openWhole(contentKey: CryptoKey, entry: number, sealed: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array> {
  const count = chunkCount(length);
  const plain = new Uint8Array(length);
  for (let chunk = 0; chunk < count; chunk += 1) {
    const start = chunk * SEALED_CHUNK_SIZE;
    const part = sealed.slice(start, Math.min(start + SEALED_CHUNK_SIZE, sealed.byteLength));
    plain.set(await openChunk(contentKey, entry, chunk, chunk === count - 1, part), chunk * CHUNK_SIZE);
  }
  return plain;
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function readKey(): Promise<string | null> {
  const value = await withStore("readonly", (store) => store.get(KEY_ENTRY));
  if (typeof value === "string") return value;
  return null;
}

export async function saveKey(key: string): Promise<void> {
  await withStore("readwrite", (store) => store.put(key, KEY_ENTRY));
}

export async function forgetKey(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(KEY_ENTRY));
}

async function withStore(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = action(database.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
