import { nameProblem } from "./names";
import { checkRules, type SiteRules } from "./rules";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PACK_MAGIC = encoder.encode("SITEPACK1\n");
export const INDEX_LENGTH_BYTES = 4;
export const PREAMBLE_LENGTH = PACK_MAGIC.byteLength + INDEX_LENGTH_BYTES;
export const MAX_DEPLOY_BYTES = 100_000_000;
export const MAX_FILES = 5000;
export const MAX_INDEX_BYTES = 2_000_000;
const MAX_PATH_LENGTH = 1024;
const MAX_TYPE_LENGTH = 200;

const ENTRY_TYPE = "application/octet-stream";
const SALT_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export type PackFile = { path: string; offset: number; length: number; type: string; gzip: boolean; br?: boolean };
export type Encrypted = { name?: string; linkSalt?: string; contentSalt: string };
export type PackIndex = { spa: boolean; files: PackFile[]; encrypted?: Encrypted; rules?: SiteRules };
export type IndexCheck = { index: PackIndex } | { problem: string };

export function encodeHeader(index: PackIndex): Uint8Array {
  const json = encoder.encode(JSON.stringify(index));
  const header = new Uint8Array(PREAMBLE_LENGTH + json.byteLength);
  header.set(PACK_MAGIC, 0);
  new DataView(header.buffer).setUint32(PACK_MAGIC.byteLength, json.byteLength);
  header.set(json, PREAMBLE_LENGTH);
  return header;
}

export function startsWithMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PACK_MAGIC.byteLength) return false;
  return PACK_MAGIC.every((byte, position) => bytes[position] === byte);
}

export function readIndexLength(preamble: Uint8Array): number {
  return new DataView(preamble.buffer, preamble.byteOffset, preamble.byteLength).getUint32(PACK_MAGIC.byteLength);
}

export function decodeIndex(json: Uint8Array): PackIndex {
  const index = JSON.parse(decoder.decode(json)) as PackIndex;
  if (index.encrypted) return { spa: false, files: index.files.map((file, number) => opaqueEntry(number, file.offset, file.length)), encrypted: index.encrypted };
  const rules = checkRules(index.rules);
  if ("problem" in rules) delete index.rules;
  else index.rules = rules.rules;
  return index;
}

export function checkIndex(json: Uint8Array, dataLength: number): IndexCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(json));
  } catch {
    return { problem: "The pack index is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null) return { problem: "The pack index must be a JSON object." };
  if ("encrypted" in parsed) return checkEncryptedIndex(parsed as { encrypted?: unknown; files?: unknown }, dataLength);
  const { spa, files } = parsed as { spa?: unknown; files?: unknown };
  if (typeof spa !== "boolean") return { problem: "The pack index needs spa set to true or false." };
  if (!Array.isArray(files) || files.length === 0) return { problem: "The pack has no files." };
  if (files.length > MAX_FILES) return { problem: `A deploy can hold at most ${MAX_FILES} files.` };

  const seen = new Set<string>();
  const checked: PackFile[] = [];
  let expectedOffset = 0;
  for (const entry of files as unknown[]) {
    const file = entry as Partial<PackFile> | null;
    if (typeof file !== "object" || file === null) return { problem: "Every pack entry must be an object." };
    const { path, offset, length, type, gzip, br } = file;
    if (typeof path !== "string" || !validPath(path)) return { problem: `The pack has a file with a bad path: ${JSON.stringify(path)}.` };
    if (seen.has(path)) return { problem: `The pack lists ${path} twice.` };
    if (offset !== expectedOffset) return { problem: `The pack's offsets do not line up at ${path}.` };
    if (!Number.isSafeInteger(length) || (length as number) < 0) return { problem: `The pack has a bad length for ${path}.` };
    if (typeof type !== "string" || type.length === 0 || type.length > MAX_TYPE_LENGTH || !/^[\x20-\x7e]+$/.test(type)) return { problem: `The pack has a bad content type for ${path}.` };
    if (typeof gzip !== "boolean") return { problem: `The pack needs a gzip flag for ${path}.` };
    if (br !== undefined && typeof br !== "boolean") return { problem: `The pack has a bad br flag for ${path}.` };
    if (br === true && gzip) return { problem: `The pack marks ${path} as both gzip and br.` };
    seen.add(path);
    const checkedFile: PackFile = { path, offset, length: length as number, type, gzip };
    if (br === true) checkedFile.br = true;
    checked.push(checkedFile);
    expectedOffset += length as number;
  }
  if (expectedOffset !== dataLength) return { problem: "The pack's file lengths do not add up to the upload size." };
  const rules = checkRules((parsed as { rules?: unknown }).rules);
  if ("problem" in rules) return { problem: rules.problem };
  const index: PackIndex = { spa, files: checked };
  if (rules.rules !== undefined) index.rules = rules.rules;
  return { index };
}

function checkEncryptedIndex(parsed: { encrypted?: unknown; files?: unknown }, dataLength: number): IndexCheck {
  if ("rules" in parsed) return { problem: "An encrypted pack keeps its rules in the sealed index only." };
  const encrypted = checkEncrypted(parsed.encrypted);
  if (encrypted === null) return { problem: "The pack's encrypted details need a contentSalt and either a name or a linkSalt." };
  const { files } = parsed;
  if (!Array.isArray(files) || files.length < 2) return { problem: "The pack has no files." };
  if (files.length > MAX_FILES + 1) return { problem: `A deploy can hold at most ${MAX_FILES} files.` };

  const entries: PackFile[] = [];
  let expectedOffset = 0;
  for (const [number, entry] of (files as unknown[]).entries()) {
    if (typeof entry !== "object" || entry === null) return { problem: "Every pack entry must be an object." };
    const { offset, length } = entry as { offset?: unknown; length?: unknown };
    if (Object.keys(entry).length !== 2) return { problem: `Encrypted pack entry ${number} must have only an offset and a length.` };
    if (offset !== expectedOffset) return { problem: `The pack's offsets do not line up at entry ${number}.` };
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return { problem: `The pack has a bad length for entry ${number}.` };
    entries.push(opaqueEntry(number, offset, length));
    expectedOffset += length;
  }
  if (expectedOffset !== dataLength) return { problem: "The pack's file lengths do not add up to the upload size." };
  return { index: { spa: false, files: entries, encrypted } };
}

function checkEncrypted(value: unknown): Encrypted | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, linkSalt, contentSalt } = value as { name?: unknown; linkSalt?: unknown; contentSalt?: unknown };
  if (typeof contentSalt !== "string" || !SALT_PATTERN.test(contentSalt)) return null;
  if (Object.keys(value).length !== 2) return null;
  if (typeof name === "string" && nameProblem(name) === null) return { name, contentSalt };
  if (typeof linkSalt === "string" && SALT_PATTERN.test(linkSalt)) return { linkSalt, contentSalt };
  return null;
}

function opaqueEntry(number: number, offset: number, length: number): PackFile {
  return { path: String(number), offset, length, type: ENTRY_TYPE, gzip: false };
}

export function validPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || character === "\\") return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export class StreamTaker {
  private chunks: Uint8Array[] = [];
  private bufferedLength = 0;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async take(count: number): Promise<Uint8Array> {
    while (this.bufferedLength < count) {
      const { done, value } = await this.reader.read();
      if (done) break;
      this.chunks.push(value);
      this.bufferedLength += value.byteLength;
    }
    const buffered = concat(this.chunks);
    const taken = buffered.slice(0, count);
    const left = buffered.slice(taken.byteLength);
    this.chunks = [left];
    this.bufferedLength = left.byteLength;
    return taken;
  }

  remaining(prefix: Uint8Array[]): ReadableStream<Uint8Array> {
    const queued = [...prefix, ...this.chunks];
    const reader = this.reader;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (queued.length > 0) {
          const next = queued.shift() as Uint8Array;
          if (next.byteLength > 0) {
            controller.enqueue(next);
            return;
          }
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      }
    });
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    joined.set(chunk, position);
    position += chunk.byteLength;
  }
  return joined;
}
