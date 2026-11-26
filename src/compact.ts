import type { Env } from "./env";
import { isDeployId } from "./names";
import {
  decodeIndex,
  encodeHeader,
  INDEX_LENGTH_BYTES,
  MAX_FILES,
  MAX_INDEX_BYTES,
  PREAMBLE_LENGTH,
  readIndexLength,
  validPath,
  validType,
  type PackFile,
  type PackIndex,
  type StreamTaker
} from "./pack";
import { checkRules, type SiteRules } from "./rules";
import { knownType } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const COMPACT_MAGIC = encoder.encode("SITEPACK2\n");
const MAX_REUSED_DEPLOYS = 8;
const MAX_COPIES = 100;
const HEAD_READ_BYTES = 65_536;
const UNKNOWN_TYPE = "application/octet-stream";
const COPIES_IN_FLIGHT = 4;

export type CompactPack = { index: PackIndex; source: ReadableStream<Uint8Array>; total: number } | { problem: string; status: 400 | 412 };

type Reuse = { id: string; file: number };
type CompactEntry = { path: string; length: number; type: string; encoding: "br" | "gzip" | null; reuse: Reuse | null };
type Earlier = { files: PackFile[]; dataStart: number };
type Segment = { kind: "body"; length: number } | { kind: "copy"; id: string; offset: number; length: number };

const STALE = { problem: "An earlier deploy this one builds on is gone; deploy again.", status: 412 as const };

export function startsWithCompactMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < COMPACT_MAGIC.byteLength) return false;
  return COMPACT_MAGIC.every((byte, position) => bytes[position] === byte);
}

export async function readCompactPack(env: Env, taker: StreamTaker, bodyLength: number, owner: string | null): Promise<CompactPack> {
  const lengthBytes = await taker.take(INDEX_LENGTH_BYTES);
  if (lengthBytes.byteLength < INDEX_LENGTH_BYTES) return malformed("The pack ends before its index.");
  const compressedLength = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, lengthBytes.byteLength).getUint32(0);
  const dataLength = bodyLength - COMPACT_MAGIC.byteLength - INDEX_LENGTH_BYTES - compressedLength;
  if (compressedLength > MAX_INDEX_BYTES) return malformed("The pack index is too large.");
  if (dataLength < 0) return malformed("The pack ends before its index.");
  const compressed = await taker.take(compressedLength);
  const json = await inflate(compressed);
  if (json === null) return malformed("The pack index is not valid brotli or is too large.");
  const entries = checkEntries(json);
  if ("problem" in entries) return malformed(entries.problem);
  const reusedIds = [...new Set(entries.files.flatMap((entry) => (entry.reuse ? [entry.reuse.id] : [])))];
  if (reusedIds.length > 0 && owner === null) return malformed("Reusing files from an earlier deploy needs your key.");
  if (reusedIds.length > MAX_REUSED_DEPLOYS) return malformed(`A deploy can reuse files from at most ${MAX_REUSED_DEPLOYS} earlier deploys.`);
  const earlier = new Map<string, Earlier>();
  for (const id of reusedIds) {
    const loaded = await loadEarlier(env, id, owner);
    if (loaded === null) return STALE;
    earlier.set(id, loaded);
  }
  const files: PackFile[] = [];
  const segments: Segment[] = [];
  let offset = 0;
  let bodyBytes = 0;
  for (const entry of entries.files) {
    const file: PackFile = { path: entry.path, offset, length: entry.length, type: entry.type, gzip: entry.encoding === "gzip" };
    if (entry.encoding === "br") file.br = true;
    if (entry.reuse) {
      const source = earlier.get(entry.reuse.id) as Earlier;
      const original = source.files[entry.reuse.file];
      if (!original || original.length !== entry.length || encodingOf(original) !== entry.encoding) return STALE;
      addSegment(segments, { kind: "copy", id: entry.reuse.id, offset: source.dataStart + original.offset, length: entry.length });
      file.origin = original.origin ?? `${entry.reuse.id}-${entry.reuse.file}`;
    } else {
      addSegment(segments, { kind: "body", length: entry.length });
      bodyBytes += entry.length;
    }
    files.push(file);
    offset += entry.length;
  }
  if (bodyBytes !== dataLength) return malformed("The pack's file lengths do not add up to the upload size.");
  if (segments.filter((segment) => segment.kind === "copy").length > MAX_COPIES) return malformed(`A deploy can reuse at most ${MAX_COPIES} runs of earlier files.`);
  const index: PackIndex = { spa: entries.spa, files };
  if (entries.rules !== undefined) index.rules = entries.rules;
  const header = encodeHeader(index);
  return { index, source: assemble(env, header, segments, taker.remaining([])), total: header.byteLength + offset };
}

function addSegment(segments: Segment[], next: Segment): void {
  if (next.length === 0) return;
  const last = segments.at(-1);
  if (last?.kind === "body" && next.kind === "body") {
    last.length += next.length;
    return;
  }
  if (last?.kind === "copy" && next.kind === "copy" && last.id === next.id && last.offset + last.length === next.offset) {
    last.length += next.length;
    return;
  }
  segments.push(next);
}

function assemble(env: Env, header: Uint8Array, segments: Segment[], body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let leftover: Uint8Array = new Uint8Array(0);
  let position = -1;
  let bodyLeft = 0;
  let copying: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const fetches = new Map<number, Promise<R2ObjectBody | null>>();
  const prefetch = (from: number): void => {
    let inFlight = [...fetches.keys()].filter((index) => index >= from).length;
    for (let index = from; index < segments.length && inFlight < COPIES_IN_FLIGHT; index += 1) {
      const segment = segments[index];
      if (segment.kind !== "copy" || fetches.has(index)) continue;
      const fetched = env.SITES.get(`d/${segment.id}`, { range: { offset: segment.offset, length: segment.length } }).catch(() => null);
      fetches.set(index, fetched);
      inFlight += 1;
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (position === -1) {
          position = 0;
          prefetch(0);
          controller.enqueue(header);
          return;
        }
        if (copying !== null) {
          const { done, value } = await copying.read();
          if (!done) {
            controller.enqueue(value);
            return;
          }
          copying = null;
          position += 1;
          continue;
        }
        if (bodyLeft > 0) {
          if (leftover.byteLength === 0) {
            const { done, value } = await reader.read();
            if (done) {
              controller.error(new Error("The upload ended early."));
              return;
            }
            leftover = value;
          }
          const taken = leftover.subarray(0, bodyLeft);
          leftover = leftover.subarray(taken.byteLength);
          bodyLeft -= taken.byteLength;
          if (bodyLeft === 0) position += 1;
          controller.enqueue(taken);
          return;
        }
        const segment = segments[position];
        if (segment === undefined) {
          const { done } = await reader.read();
          if (!done || leftover.byteLength > 0) {
            controller.error(new Error("The upload was longer than it said."));
            return;
          }
          controller.close();
          return;
        }
        if (segment.kind === "body") {
          bodyLeft = segment.length;
          continue;
        }
        prefetch(position);
        const object = await fetches.get(position);
        fetches.delete(position);
        prefetch(position + 1);
        if (!object) {
          controller.error(new Error("An earlier deploy disappeared while copying."));
          return;
        }
        copying = object.body.getReader();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      if (copying !== null) await copying.cancel(reason);
    }
  });
}

async function loadEarlier(env: Env, id: string, owner: string | null): Promise<Earlier | null> {
  const start = await env.SITES.get(`d/${id}`, { range: { offset: 0, length: HEAD_READ_BYTES } });
  if (start === null || owner === null || start.customMetadata?.owner !== owner) return null;
  let bytes = new Uint8Array(await start.arrayBuffer());
  const headerLength = PREAMBLE_LENGTH + readIndexLength(bytes);
  if (headerLength > bytes.byteLength) {
    const whole = await env.SITES.get(`d/${id}`, { range: { offset: 0, length: headerLength } });
    if (whole === null) return null;
    bytes = new Uint8Array(await whole.arrayBuffer());
  }
  const index = decodeIndex(bytes.subarray(PREAMBLE_LENGTH, headerLength));
  if (index.encrypted) return null;
  return { files: index.files, dataStart: headerLength };
}

function encodingOf(file: PackFile): "br" | "gzip" | null {
  if (file.br) return "br";
  if (file.gzip) return "gzip";
  return null;
}

function checkEntries(json: Uint8Array): { spa: boolean; files: CompactEntry[]; rules?: SiteRules } | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(json));
  } catch {
    return { problem: "The pack index is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null) return { problem: "The pack index must be a JSON object." };
  const { spa, files, rules } = parsed as { spa?: unknown; files?: unknown; rules?: unknown };
  if (typeof spa !== "boolean") return { problem: "The pack index needs spa set to true or false." };
  if (!Array.isArray(files) || files.length === 0) return { problem: "The pack has no files." };
  if (files.length > MAX_FILES) return { problem: `A deploy can hold at most ${MAX_FILES} files.` };
  const checkedRules = checkRules(rules);
  if ("problem" in checkedRules) return { problem: checkedRules.problem };
  const seen = new Set<string>();
  const checked: CompactEntry[] = [];
  for (const entry of files as unknown[]) {
    if (typeof entry !== "object" || entry === null) return { problem: "Every pack entry must be an object." };
    const { path, length, type, encoding, reuse } = entry as { path?: unknown; length?: unknown; type?: unknown; encoding?: unknown; reuse?: unknown };
    if (typeof path !== "string" || !validPath(path)) return { problem: `The pack has a file with a bad path: ${JSON.stringify(path)}.` };
    if (seen.has(path)) return { problem: `The pack lists ${path} twice.` };
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return { problem: `The pack has a bad length for ${path}.` };
    if (type !== undefined && !validType(type)) return { problem: `The pack has a bad content type for ${path}.` };
    if (encoding !== undefined && encoding !== "br" && encoding !== "gzip") return { problem: `The pack has a bad encoding for ${path}.` };
    const checkedReuse = checkReuse(reuse);
    if (checkedReuse === "bad") return { problem: `The pack has a bad reuse entry for ${path}.` };
    seen.add(path);
    checked.push({ path, length, type: type ?? knownType(path) ?? UNKNOWN_TYPE, encoding: encoding ?? null, reuse: checkedReuse });
  }
  if (checkedRules.rules === undefined) return { spa, files: checked };
  return { spa, files: checked, rules: rules as SiteRules };
}

function checkReuse(reuse: unknown): Reuse | null | "bad" {
  if (reuse === undefined) return null;
  if (typeof reuse !== "object" || reuse === null) return "bad";
  const { id, file } = reuse as { id?: unknown; file?: unknown };
  if (typeof id !== "string" || !isDeployId(id)) return "bad";
  if (typeof file !== "number" || !Number.isSafeInteger(file) || file < 0) return "bad";
  return { id, file };
}

function malformed(problem: string): { problem: string; status: 400 } {
  return { problem, status: 400 };
}

async function inflate(compressed: Uint8Array): Promise<Uint8Array | null> {
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("brotli")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INDEX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const joined = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    joined.set(chunk, position);
    position += chunk.byteLength;
  }
  return joined;
}
