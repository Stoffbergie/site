import { collapseSlashes, decodePath, findPage, resolve, type ListedFile, type Listing, type Target } from "./resolve";

export type RedirectStatus = 200 | 301 | 302 | 303 | 307 | 308 | 404;
export type RedirectRule = { from: string; to: string; status: RedirectStatus; force: boolean };
export type HeaderLine = { name: string; value?: string };
export type HeaderRule = { path: string; headers: HeaderLine[] };
export type SiteRules = { redirects: RedirectRule[]; headers: HeaderRule[] };
export type RulesCheck = { rules: SiteRules | undefined } | { problem: string };
export type Routed = { kind: "redirect"; status: number; location: string } | { kind: "target"; target: Target };
export type RouteOptions = { privateSite: boolean };

export const MAX_REDIRECTS = 10_000;
export const MAX_DYNAMIC_REDIRECTS = 1_000;
export const MAX_HEADER_RULES = 1_000;
export const MAX_HEADER_LINES = 2_000;
const MAX_RULE_TEXT = 2_000;
const MAX_HEADER_NAME = 200;
const MAX_ADDED_HEADER_BYTES = 32_768;
const MAX_DESTINATION_LENGTH = 16_384;

const CONFIG_FILES = new Set(["_redirects", "_headers"]);
const REDIRECT_STATUSES = new Set([200, 301, 302, 303, 307, 308, 404]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;
const LOCATION = /^[\x21-\x7e]+$/;
const PLACEHOLDER = /^:([A-Za-z]\w*)(.*)$/;
const REFERENCE = /:([A-Za-z]\w*)/g;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * Header names a site cannot set or remove: the host needs them for transport, caching and revalidation, and every site shares one registrable domain with the others and the API, so cookies, clearing site data, agent clustering and reporting policies that cover more than one origin would reach them.
 */
export const FIXED_HEADERS = new Set([
  "accept-ranges",
  "age",
  "allow",
  "alt-svc",
  "cdn-cache-control",
  "clear-site-data",
  "cloudflare-cdn-cache-control",
  "connection",
  "content-encoding",
  "content-length",
  "content-range",
  "date",
  "etag",
  "keep-alive",
  "location",
  "nel",
  "origin-agent-cluster",
  "proxy-authenticate",
  "proxy-authorization",
  "report-to",
  "sec-session-challenge",
  "sec-session-registration",
  "secure-session-challenge",
  "secure-session-registration",
  "server",
  "set-cookie",
  "set-cookie2",
  "surrogate-control",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "vary",
  "x-content-type-options"
]);

type Piece = { kind: "literal"; text: string } | { kind: "placeholder"; name: string; tail: string };
type Pattern = { before: Piece[]; splat: { prefix: string; suffix: string } | null; after: Piece[]; dynamic: boolean };
type Captures = Map<string, string>;
type Compiled = { redirects: Pattern[]; staticRedirects: Map<string, number[]>; dynamicRedirects: number[]; headers: Pattern[] };
type Found = { rule: RedirectRule; captures: Captures };
type VisibleFiles = { files: ListedFile[]; byPath: Map<string, number>; numbers: number[] };
type Directive = { name: string; hasArgument: boolean };
type Chosen = { name: string; value: string | null; sent: string | null };

const compiledRules = new WeakMap<SiteRules, Compiled>();
const visibleFilesOf = new WeakMap<ListedFile[], VisibleFiles>();

export function isConfigFile(path: string): boolean {
  return CONFIG_FILES.has(path);
}

/**
 * Checks the optional `rules` field of a pack index. Unknown fields are ignored so a newer CLI can add them.
 */
export function checkRules(value: unknown): RulesCheck {
  if (value === undefined) return { rules: undefined };
  if (typeof value !== "object" || value === null) return { problem: "The pack's rules must be an object." };
  const { redirects = [], headers = [] } = value as { redirects?: unknown; headers?: unknown };
  if (!Array.isArray(redirects) || redirects.length > MAX_REDIRECTS) return { problem: `The pack's redirect rules must be a list of at most ${MAX_REDIRECTS}.` };
  if (!Array.isArray(headers) || headers.length > MAX_HEADER_RULES) return { problem: `The pack's header rules must be a list of at most ${MAX_HEADER_RULES}.` };

  const checkedRedirects: RedirectRule[] = [];
  let dynamicCount = 0;
  for (const [number, entry] of (redirects as unknown[]).entries()) {
    const rule = checkRedirect(entry);
    if (rule === null) return { problem: `The pack's redirect rule ${number} is malformed.` };
    if (compile(rule.from).dynamic) dynamicCount += 1;
    checkedRedirects.push(rule);
  }
  if (dynamicCount > MAX_DYNAMIC_REDIRECTS) return { problem: `A deploy can have at most ${MAX_DYNAMIC_REDIRECTS} redirect rules with * or placeholders.` };

  const checkedHeaders: HeaderRule[] = [];
  let lineCount = 0;
  for (const [number, entry] of (headers as unknown[]).entries()) {
    const rule = checkHeaderRule(entry);
    if (rule === null) return { problem: `The pack's header rule ${number} is malformed.` };
    lineCount += rule.headers.length;
    checkedHeaders.push(rule);
  }
  if (lineCount > MAX_HEADER_LINES) return { problem: `A deploy can have at most ${MAX_HEADER_LINES} header lines.` };
  return { rules: { redirects: checkedRedirects, headers: checkedHeaders } };
}

function checkRedirect(entry: unknown): RedirectRule | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { from, to, status, force } = entry as { from?: unknown; to?: unknown; status?: unknown; force?: unknown };
  if (!validPattern(from)) return null;
  if (typeof to !== "string" || to.length > MAX_RULE_TEXT || !LOCATION.test(to)) return null;
  if (typeof status !== "number" || !REDIRECT_STATUSES.has(status)) return null;
  if (typeof force !== "boolean") return null;
  const external = /^https?:\/\//i.test(to);
  if (!external && !to.startsWith("/")) return null;
  if (external && (status === 200 || status === 404)) return null;
  return { from, to, status: status as RedirectStatus, force };
}

function checkHeaderRule(entry: unknown): HeaderRule | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { path, headers } = entry as { path?: unknown; headers?: unknown };
  if (!validPattern(path)) return null;
  if (!Array.isArray(headers)) return null;
  const lines: HeaderLine[] = [];
  for (const line of headers as unknown[]) {
    if (typeof line !== "object" || line === null) return null;
    const { name, value } = line as { name?: unknown; value?: unknown };
    if (typeof name !== "string" || name.length > MAX_HEADER_NAME || !HEADER_NAME.test(name)) return null;
    if (value === undefined) {
      lines.push({ name });
      continue;
    }
    if (typeof value !== "string" || value.length > MAX_RULE_TEXT || !HEADER_VALUE.test(value)) return null;
    lines.push({ name, value });
  }
  return { path, headers: lines };
}

function validPattern(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > MAX_RULE_TEXT) return false;
  if (LONE_SURROGATE.test(value)) return false;
  return value.indexOf("*") === value.lastIndexOf("*");
}

/**
 * Routes a decoded request path through a site's redirect rules, then through `resolve`. Rules match the path with doubled slashes collapsed, as `resolve` reads it. The first matching rule that applies wins: one whose destination is refused is skipped, and one that is not forced gives way to a page `resolve` finds by name at the path, before any of its fallbacks. On private sites a redirect to another origin carries a fragment of its own. The rule files themselves are never served.
 */
export function route(listing: Listing, rules: SiteRules | undefined, pathname: string, requestUrl: URL, options: RouteOptions): Routed {
  if (rules !== undefined) {
    for (const found of matchingRedirects(rules, pathname)) {
      if (!found.rule.force && exists(listing, pathname)) break;
      const routed = follow(listing, found.rule, found.captures, pathname, requestUrl, options);
      if (routed !== null) return routed;
    }
  }
  return { kind: "target", target: resolveVisible(listing, pathname) };
}

function follow(listing: Listing, rule: RedirectRule, captures: Captures, pathname: string, requestUrl: URL, options: RouteOptions): Routed | null {
  const destination = fill(rule.to, captures, encodePathValue, MAX_DESTINATION_LENGTH);
  if (destination === null) return null;
  const resolved = resolveUrl(destination, requestUrl);
  if (resolved === null) return null;
  const sameOrigin = resolved.origin === requestUrl.origin;
  if (rule.to.startsWith("/") && !sameOrigin) return null;
  if (rule.status === 200 || rule.status === 404) {
    return { kind: "target", target: rewriteTarget(listing, resolved, rule.status) };
  }
  let location = withQuery(destination, requestUrl.search);
  if (options.privateSite && !sameOrigin && !location.includes("#")) location = `${location}#`;
  if (location.length > MAX_DESTINATION_LENGTH) return null;
  const redirected = resolveUrl(location, requestUrl);
  if (redirected === null || sameAddress(redirected, pathname, requestUrl)) return null;
  return { kind: "redirect", status: rule.status, location };
}

function* matchingRedirects(rules: SiteRules, pathname: string): Generator<Found> {
  const compiled = compiledFor(rules);
  const segments = segmentsOf(pathname);
  const staticNumbers = compiled.staticRedirects.get(normalize(pathname)) ?? [];
  let nextStatic = 0;
  for (const number of compiled.dynamicRedirects) {
    while (nextStatic < staticNumbers.length && staticNumbers[nextStatic] < number) {
      yield { rule: rules.redirects[staticNumbers[nextStatic]], captures: new Map() };
      nextStatic += 1;
    }
    const captures = match(compiled.redirects[number], segments);
    if (captures !== null) yield { rule: rules.redirects[number], captures };
  }
  while (nextStatic < staticNumbers.length) {
    yield { rule: rules.redirects[staticNumbers[nextStatic]], captures: new Map() };
    nextStatic += 1;
  }
}

function exists(listing: Listing, pathname: string): boolean {
  return findVisiblePage(listing, pathname) !== null;
}

function rewriteTarget(listing: Listing, destination: URL, status: 200 | 404): Target {
  const path = decodePath(destination.pathname);
  if (path === null) return notFoundTarget(listing);
  let page = findVisiblePage(listing, path);
  if (page !== null && page.kind === "redirect") page = findVisiblePage(listing, page.path);
  if (page !== null && page.kind === "file") return { kind: "file", number: page.number, status };
  if (page === null && status === 200 && collapseSlashes(path) === "/") return resolveVisible(listing, "/");
  return notFoundTarget(listing);
}

function resolveVisible(listing: Listing, pathname: string): Target {
  const visible = visibleFiles(listing);
  if (visible === null) return resolve(listing, pathname);
  const target = resolve({ spa: listing.spa, files: visible.files, byPath: visible.byPath }, pathname);
  return inListing(listing, visible, target);
}

function findVisiblePage(listing: Listing, pathname: string): Target | null {
  const visible = visibleFiles(listing);
  if (visible === null) return findPage(listing, pathname);
  const page = findPage({ spa: listing.spa, files: visible.files, byPath: visible.byPath }, pathname);
  if (page === null) return null;
  return inListing(listing, visible, page);
}

function inListing(listing: Listing, visible: VisibleFiles, target: Target): Target {
  if (target.kind === "file") return { kind: "file", number: visible.numbers[target.number], status: target.status };
  if (target.kind === "list" && visible.files.length === 0) return notFoundTarget(listing);
  return target;
}

function visibleFiles(listing: Listing): VisibleFiles | null {
  let hasConfigFile = false;
  for (const name of CONFIG_FILES) {
    if (listing.byPath.has(name)) hasConfigFile = true;
  }
  if (!hasConfigFile) return null;
  const remembered = visibleFilesOf.get(listing.files);
  if (remembered) return remembered;
  const files: ListedFile[] = [];
  const numbers: number[] = [];
  for (const [number, file] of listing.files.entries()) {
    if (isConfigFile(file.path)) continue;
    files.push(file);
    numbers.push(number);
  }
  const visible = { files, byPath: new Map(files.map((file, position) => [file.path, position])), numbers };
  visibleFilesOf.set(listing.files, visible);
  return visible;
}

function notFoundTarget(listing: Listing): Target {
  const notFoundPage = listing.byPath.get("404.html");
  if (notFoundPage !== undefined) return { kind: "file", number: notFoundPage, status: 404 };
  return { kind: "missing" };
}

function resolveUrl(destination: string, requestUrl: URL): URL | null {
  try {
    return new URL(destination, requestUrl);
  } catch {
    return null;
  }
}

function withQuery(destination: string, search: string): string {
  const hash = destination.indexOf("#");
  let beforeFragment = destination;
  if (hash !== -1) beforeFragment = destination.slice(0, hash);
  if (search === "" || beforeFragment.includes("?")) return destination;
  if (hash === -1) return `${destination}${search}`;
  return `${beforeFragment}${search}${destination.slice(hash)}`;
}

function sameAddress(location: URL, pathname: string, requestUrl: URL): boolean {
  if (location.origin !== requestUrl.origin || location.search !== requestUrl.search) return false;
  const path = decodePath(location.pathname);
  return path !== null && normalize(path) === normalize(pathname);
}

/**
 * Applies a site's header rules for a request path to a response's headers, in file order, and returns the lowercased names of the headers it set or removed. Values for the same name are joined with a comma, `! Name` removes what earlier rules or the host set, fixed headers stay as they are, and on named hosts the host's `Cache-Control` stays unless the site's own asks for no caching. Lines that would take the custom headers, with what the host appends to them, past their size budget are skipped.
 */
export function applyHeaderRules(headers: Headers, rules: SiteRules | undefined, pathname: string, named: boolean): string[] {
  if (rules === undefined || rules.headers.length === 0) return [];
  const compiled = compiledFor(rules);
  const segments = segmentsOf(pathname);
  const chosen = new Map<string, Chosen>();
  let used = 0;
  for (const [number, rule] of rules.headers.entries()) {
    const captures = match(compiled.headers[number], segments);
    if (captures === null) continue;
    for (const line of rule.headers) {
      const key = line.name.toLowerCase();
      if (FIXED_HEADERS.has(key)) continue;
      const earlier = chosen.get(key);
      const earlierSize = sizeOf(earlier);
      if (line.value === undefined) {
        used -= earlierSize;
        chosen.set(key, { name: line.name, value: null, sent: null });
        continue;
      }
      const room = MAX_ADDED_HEADER_BYTES - used + earlierSize;
      const value = fill(line.value, captures, encodeHeaderValue, room);
      if (value === null) continue;
      let name = line.name;
      let joined = value;
      if (earlier?.value) {
        name = earlier.name;
        joined = `${earlier.value}, ${value}`;
      }
      const entry: Chosen = { name, value: joined, sent: sentValue(key, joined, named) };
      const size = sizeOf(entry);
      if (size > room) continue;
      used += size - earlierSize;
      chosen.set(key, entry);
    }
  }

  const decided: string[] = [];
  for (const [key, { name, value, sent }] of chosen) {
    if (sent !== null) {
      headers.set(name, sent);
      decided.push(key);
      continue;
    }
    if (value === null && key !== "cache-control") {
      headers.delete(name);
      decided.push(key);
    }
  }
  return decided;
}

function sentValue(key: string, value: string, named: boolean): string | null {
  if (key === "cache-control") return siteCacheControl(value, named);
  return value;
}

function sizeOf(entry: Chosen | undefined): number {
  if (entry === undefined || entry.sent === null) return 0;
  return entry.name.length + entry.sent.length;
}

function siteCacheControl(value: string, named: boolean): string | null {
  if (value.trim() === "") return null;
  const directives = cacheDirectives(value);
  if (directives === null) return null;
  if (named && !hasBareDirective(directives, "no-cache") && !hasBareDirective(directives, "no-store")) return null;
  if (hasBareDirective(directives, "no-transform")) return value;
  return `${value}, no-transform`;
}

function cacheDirectives(value: string): Directive[] | null {
  const parts: string[] = [];
  let part = "";
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      parts.push(part);
      part = "";
      continue;
    }
    part += character;
  }
  if (quoted) return null;
  parts.push(part);
  const directives: Directive[] = [];
  for (const text of parts) {
    const equals = text.indexOf("=");
    if (equals === -1) {
      directives.push({ name: text.trim().toLowerCase(), hasArgument: false });
    } else {
      directives.push({ name: text.slice(0, equals).trim().toLowerCase(), hasArgument: true });
    }
  }
  return directives;
}

function hasBareDirective(directives: Directive[], name: string): boolean {
  return directives.some((directive) => directive.name === name && !directive.hasArgument);
}

function compiledFor(rules: SiteRules): Compiled {
  const remembered = compiledRules.get(rules);
  if (remembered) return remembered;
  const redirects = rules.redirects.map((rule) => compile(rule.from));
  const staticRedirects = new Map<string, number[]>();
  const dynamicRedirects: number[] = [];
  for (const [number, pattern] of redirects.entries()) {
    if (pattern.dynamic) {
      dynamicRedirects.push(number);
      continue;
    }
    const key = normalize(rules.redirects[number].from);
    const numbers = staticRedirects.get(key);
    if (numbers === undefined) staticRedirects.set(key, [number]);
    else numbers.push(number);
  }
  const compiled = { redirects, staticRedirects, dynamicRedirects, headers: rules.headers.map((rule) => compile(rule.path)) };
  compiledRules.set(rules, compiled);
  return compiled;
}

function compile(source: string): Pattern {
  const before: Piece[] = [];
  const after: Piece[] = [];
  let splat: Pattern["splat"] = null;
  let dynamic = false;
  for (const segment of segmentsOf(source)) {
    const star = segment.indexOf("*");
    if (star !== -1) {
      dynamic = true;
      const suffix = segment.slice(star + 1);
      if (splat !== null || suffix.includes("*")) return neverMatches();
      splat = { prefix: segment.slice(0, star), suffix };
      continue;
    }
    let piece: Piece = { kind: "literal", text: segment };
    const placeholder = PLACEHOLDER.exec(segment);
    if (placeholder !== null) {
      dynamic = true;
      piece = { kind: "placeholder", name: placeholder[1], tail: placeholder[2] };
    }
    if (splat === null) before.push(piece);
    else after.push(piece);
  }
  return { before, splat, after, dynamic };
}

function neverMatches(): Pattern {
  return { before: [{ kind: "literal", text: "/" }], splat: null, after: [], dynamic: true };
}

function match(pattern: Pattern, segments: string[]): Captures | null {
  const captures: Captures = new Map();
  const fixedCount = pattern.before.length + pattern.after.length;
  if (pattern.splat === null && segments.length !== fixedCount) return null;
  if (segments.length < fixedCount) return null;
  for (const [position, piece] of pattern.before.entries()) {
    if (!matchPiece(piece, segments[position], captures)) return null;
  }
  const afterStart = segments.length - pattern.after.length;
  for (const [position, piece] of pattern.after.entries()) {
    if (!matchPiece(piece, segments[afterStart + position], captures)) return null;
  }
  if (pattern.splat === null) return captures;
  const middle = segments.slice(pattern.before.length, afterStart).join("/");
  const { prefix, suffix } = pattern.splat;
  if (middle.length < prefix.length + suffix.length) return null;
  if (!middle.startsWith(prefix) || !middle.endsWith(suffix)) return null;
  captures.set("splat", middle.slice(prefix.length, middle.length - suffix.length));
  return captures;
}

function matchPiece(piece: Piece, segment: string, captures: Captures): boolean {
  if (piece.kind === "literal") return piece.text === segment;
  if (segment.length <= piece.tail.length || !segment.endsWith(piece.tail)) return false;
  captures.set(piece.name, segment.slice(0, segment.length - piece.tail.length));
  return true;
}

function segmentsOf(path: string): string[] {
  const normalized = normalize(path);
  if (normalized === "/") return [];
  return normalized.slice(1).split("/");
}

function normalize(path: string): string {
  const collapsed = collapseSlashes(path);
  if (collapsed.length > 1 && collapsed.endsWith("/")) return collapsed.slice(0, -1);
  return collapsed;
}

function fill(template: string, captures: Captures, encode: (value: string) => string, limit: number): string | null {
  if (captures.size === 0) {
    if (template.length > limit) return null;
    return template;
  }
  let filled = "";
  let position = 0;
  for (const reference of template.matchAll(REFERENCE)) {
    const value = captures.get(reference[1]);
    let replacement = reference[0];
    if (value !== undefined) replacement = encode(value);
    filled += template.slice(position, reference.index) + replacement;
    position = reference.index + reference[0].length;
    if (filled.length > limit) return null;
  }
  filled += template.slice(position);
  if (filled.length > limit) return null;
  return filled;
}

function encodePathValue(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, "/");
}

function encodeHeaderValue(value: string): string {
  if (HEADER_VALUE.test(value)) return value;
  return encodePathValue(value);
}
