export type ListedFile = { path: string; type: string; length: number };
export type Listing = { spa: boolean; files: ListedFile[]; byPath: Map<string, number> };
export type Target = { kind: "file"; number: number; status: 200 | 404 } | { kind: "folder" } | { kind: "page" } | { kind: "list" } | { kind: "missing" };
export type ByteRange = { offset: number; length: number };

/**
 * Maps a decoded request path to a file of a deploy. The Worker uses it for public sites and the service worker for encrypted ones, so both serve the same paths.
 */
export function resolve(listing: Listing, pathname: string): Target {
  const { byPath, files } = listing;
  const relative = collapseSlashes(pathname).slice(1);

  const candidates: string[] = [];
  if (relative === "" || relative.endsWith("/")) {
    candidates.push(`${relative}index.html`, `${relative}index.htm`);
  } else {
    candidates.push(relative, `${relative}.html`, `${relative}.htm`);
  }
  const exactly = (path: string): number | undefined => byPath.get(path);
  const foldedPaths = foldedPathsOf(files);
  const ignoringCase = (path: string): number | undefined => foldedPaths.get(fold(path));
  for (const lookup of [exactly, ignoringCase]) {
    const number = firstMatch(candidates, lookup);
    if (number !== undefined) return { kind: "file", number, status: 200 };
    if (relative.endsWith("/")) {
      const withoutSlash = relative.slice(0, -1);
      const page = firstMatch([withoutSlash, `${withoutSlash}.html`, `${withoutSlash}.htm`], lookup);
      if (page !== undefined) return { kind: "page" };
    }
    const folderIndex = firstMatch([`${relative}/index.html`, `${relative}/index.htm`], lookup);
    if (relative !== "" && folderIndex !== undefined) return { kind: "folder" };
  }

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

const foldedPathsCache = new WeakMap<ListedFile[], Map<string, number>>();

function foldedPathsOf(files: ListedFile[]): Map<string, number> {
  let folded = foldedPathsCache.get(files);
  if (folded === undefined) {
    folded = new Map();
    for (const [position, file] of files.entries()) {
      const key = fold(file.path);
      if (!folded.has(key)) folded.set(key, position);
    }
    foldedPathsCache.set(files, folded);
  }
  return folded;
}

function fold(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function firstMatch(paths: string[], lookup: (path: string) => number | undefined): number | undefined {
  for (const path of paths) {
    const number = lookup(path);
    if (number !== undefined) return number;
  }
  return undefined;
}

export function folderLocation(url: URL): string {
  return `${collapseSlashes(url.pathname)}/${url.search}`;
}

export function pageLocation(url: URL): string {
  return `${collapseSlashes(url.pathname).replace(/\/$/, "")}${url.search}`;
}

function collapseSlashes(pathname: string): string {
  return pathname.replace(/\/{2,}/g, "/");
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
