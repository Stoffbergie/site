import { knownType } from "./types";

export type ListedFile = { path: string; type: string; length: number };
export type Listing = { spa: boolean; files: ListedFile[]; byPath: Map<string, number> };
export type IconShape = "tab" | "touch";
export type Target = { kind: "file"; number: number; status: 200 | 404 } | { kind: "redirect"; path: string } | { kind: "list" } | { kind: "icon"; shape: IconShape } | { kind: "missing" };
export type ByteRange = { offset: number; length: number };

export const GENERATED_ICON_PATHS: Record<IconShape, string> = { tab: "/favicon.ico", touch: "/apple-touch-icon.png" };

const ICON_REQUESTS = new Map<string, { shape: IconShape; standIns: string[] }>([
  ["favicon.ico", { shape: "tab", standIns: ["favicon.png", "favicon.svg", "icon.png", "icon.svg", "apple-touch-icon.png"] }],
  ["apple-touch-icon.png", { shape: "touch", standIns: ["apple-touch-icon-precomposed.png", "icon.png", "favicon.png"] }],
  ["apple-touch-icon-precomposed.png", { shape: "touch", standIns: ["apple-touch-icon.png", "icon.png", "favicon.png"] }]
]);

/**
 * Maps a decoded request path to a file of a deploy. The Worker uses it for public sites and the service worker for encrypted ones, so both serve the same paths.
 */
export function resolve(listing: Listing, pathname: string): Target {
  const { byPath, files } = listing;
  const relative = collapseSlashes(pathname).slice(1);
  const page = findPage(listing, pathname);
  if (page !== null) return page;
  const exactly = (path: string): number | undefined => byPath.get(path);

  if (relative === "") {
    if (files.length === 1) return { kind: "file", number: 0, status: 200 };
    const pages = files.filter((file) => isHtml(file));
    if (pages.length === 1) return { kind: "file", number: files.indexOf(pages[0]), status: 200 };
    return { kind: "list" };
  }

  const icon = ICON_REQUESTS.get(relative);
  if (icon !== undefined) {
    const standIn = firstMatch(icon.standIns, exactly);
    if (standIn !== undefined) return { kind: "file", number: standIn, status: 200 };
    return { kind: "icon", shape: icon.shape };
  }

  const underBasePath = basePathAsset(files, relative, exactly);
  if (underBasePath !== undefined) return { kind: "file", number: underBasePath, status: 200 };

  const looksLikeRoute = knownType(relative) === null;
  const home = byPath.get("index.html");
  if (listing.spa && looksLikeRoute && home !== undefined) return { kind: "file", number: home, status: 200 };
  const appShell = byPath.get("200.html");
  if (appShell !== undefined && looksLikeRoute) return { kind: "file", number: appShell, status: 200 };

  const notFoundPage = byPath.get("404.html");
  if (notFoundPage !== undefined) return { kind: "file", number: notFoundPage, status: 404 };
  if (looksLikeRoute && home !== undefined && isSinglePageApp(files)) return { kind: "file", number: home, status: 200 };
  return { kind: "missing" };
}

/**
 * Looks a decoded request path up by file name alone: the exact name, `.html`, `.htm`, folder indexes and the same names ignoring letter case and Unicode form, with the folder and trailing-slash redirects they imply. It returns null where `resolve` would go on to its fallbacks.
 */
export function findPage(listing: Listing, pathname: string): Target | null {
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
  const ignoringCase = (path: string): number | undefined => {
    const number = foldedPaths.get(fold(path));
    if (number === null) return undefined;
    return number;
  };
  for (const lookup of [exactly, ignoringCase]) {
    const number = firstMatch(candidates, lookup);
    if (number !== undefined) return { kind: "file", number, status: 200 };
    if (relative.endsWith("/")) {
      const withoutSlash = relative.slice(0, -1);
      const page = firstMatch([withoutSlash, `${withoutSlash}.html`, `${withoutSlash}.htm`], lookup);
      if (page !== undefined) return { kind: "redirect", path: `/${withoutSlash}` };
    }
    const folderIndex = firstMatch([`${relative}/index.html`, `${relative}/index.htm`], lookup);
    if (relative !== "" && folderIndex !== undefined) return { kind: "redirect", path: `/${relative}/` };
  }
  return null;
}

const foldedPathsCache = new WeakMap<ListedFile[], Map<string, number | null>>();

function foldedPathsOf(files: ListedFile[]): Map<string, number | null> {
  let folded = foldedPathsCache.get(files);
  if (folded === undefined) {
    folded = new Map();
    for (const [position, file] of files.entries()) {
      const key = fold(file.path);
      if (folded.has(key)) folded.set(key, null);
      else folded.set(key, position);
    }
    foldedPathsCache.set(files, folded);
  }
  return folded;
}

function fold(path: string): string {
  return path
    .split("/")
    .map((segment) => foldSegment(segment))
    .join("/");
}

function foldSegment(segment: string): string {
  if (segment.startsWith(".")) return segment;
  return segment.normalize("NFC").toLowerCase();
}

function firstMatch(paths: string[], lookup: (path: string) => number | undefined): number | undefined {
  for (const path of paths) {
    const number = lookup(path);
    if (number !== undefined) return number;
  }
  return undefined;
}

export function redirectLocation(path: string, url: URL): string | null {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const location = `${encodedPath}${url.search}`;
  if (location === `${url.pathname}${url.search}`) return null;
  return location;
}

/**
 * Names the icon a browser asks for at a path of its own accord, whatever the page says: the tab icon or the home-screen icon.
 */
export function iconShapeAt(pathname: string): IconShape | null {
  const icon = ICON_REQUESTS.get(collapseSlashes(pathname).slice(1));
  if (icon === undefined) return null;
  return icon.shape;
}

export function isReserved(pathname: string): boolean {
  return collapseSlashes(pathname).startsWith("/__site/");
}

export function collapseSlashes(pathname: string): string {
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

function basePathAsset(files: ListedFile[], relative: string, lookup: (path: string) => number | undefined): number | undefined {
  const separator = relative.indexOf("/");
  if (separator === -1) return undefined;
  const firstSegment = relative.slice(0, separator);
  const remainder = relative.slice(separator + 1);
  if (!remainder.includes("/")) return undefined;
  const foldedFirstSegment = foldSegment(firstSegment);
  const isDeployedName = files.some((file) => foldSegment(file.path.split("/")[0]) === foldedFirstSegment);
  if (isDeployedName) return undefined;
  return lookup(remainder);
}

function isSinglePageApp(files: ListedFile[]): boolean {
  const pages = files.filter((file) => isHtml(file));
  const hasScript = files.some((file) => file.type.startsWith("text/javascript"));
  return pages.length === 1 && pages[0].path === "index.html" && hasScript;
}

function isHtml(file: ListedFile): boolean {
  return file.type.startsWith("text/html") || file.type.startsWith("application/xhtml+xml");
}
