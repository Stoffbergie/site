export type ListedFile = { path: string; type: string; length: number };
export type Listing = { spa: boolean; files: ListedFile[]; byPath: Map<string, number> };
export type Target = { kind: "file"; number: number; status: 200 | 404 } | { kind: "folder" } | { kind: "list" } | { kind: "missing" };
export type ByteRange = { offset: number; length: number };

/**
 * Maps a decoded request path to a file of a deploy. The Worker uses it for public sites and the service worker for encrypted ones, so both serve the same paths.
 */
export function resolve(listing: Listing, pathname: string): Target {
  const { byPath, files } = listing;
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
    if (files.length === 1) return { kind: "file", number: 0, status: 200 };
    const pages = files.filter((file) => isHtml(file));
    if (pages.length === 1) return { kind: "file", number: files.indexOf(pages[0]), status: 200 };
    return { kind: "list" };
  }

  const lastSegment = relative.split("/").pop() ?? "";
  const home = byPath.get("index.html");
  if (listing.spa && !lastSegment.includes(".") && home !== undefined) return { kind: "file", number: home, status: 200 };

  const notFoundPage = byPath.get("404.html");
  if (notFoundPage !== undefined) return { kind: "file", number: notFoundPage, status: 404 };
  return { kind: "missing" };
}

export function byPathOf(files: ListedFile[]): Map<string, number> {
  return new Map(files.map((file, position) => [file.path, position]));
}

export function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

export function parseRange(header: string, size: number): ByteRange | null {
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

function isHtml(file: ListedFile): boolean {
  return file.type.startsWith("text/html");
}
