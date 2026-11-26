import table from "../cli/src/types.json";

export const SNIFF_BYTES = 512;
const TEXT = "text/plain; charset=utf-8";
const BINARY = "application/octet-stream";

const paths = new Map<string, string>(Object.entries(table.paths));
const extensions = new Map<string, string>(Object.entries(table.extensions));

export function knownType(path: string): string | null {
  const exact = paths.get(path);
  if (exact !== undefined) return exact;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  return extensions.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

export function sniffedType(head: Uint8Array): string {
  const binary = head.some((byte) => byte <= 0x08 || byte === 0x0b || (byte >= 0x0e && byte <= 0x1a) || (byte >= 0x1c && byte <= 0x1f));
  if (binary) return BINARY;
  return TEXT;
}
