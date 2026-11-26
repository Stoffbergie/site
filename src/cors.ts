const EXPOSED_HEADERS = "Accept-Ranges, Content-Encoding, Content-Length, Content-Range, ETag";
export const READ_METHODS = "GET, HEAD, OPTIONS";
const PREFLIGHT_SECONDS = "86400";

export function preflight(request: Request): Response {
  const headers = new Headers({
    Allow: READ_METHODS,
    "Access-Control-Allow-Methods": READ_METHODS,
    "Access-Control-Max-Age": PREFLIGHT_SECONDS,
    "Cache-Control": "no-cache, no-transform"
  });
  const requestedHeaders = request.headers.get("access-control-request-headers");
  if (requestedHeaders !== null) headers.set("Access-Control-Allow-Headers", requestedHeaders);
  allowOrigin(request, headers);
  return new Response(null, { status: 204, headers });
}

const siteDecisions = new WeakMap<Response, string[]>();

export function keepSiteDecisions(response: Response, headerNames: string[]): void {
  siteDecisions.set(response, headerNames);
}

export function openToOtherOrigins(request: Request, response: Response): Response {
  const decidedBySite = siteDecisions.get(response) ?? [];
  const siteDecidedOrigin = decidedBySite.includes("access-control-allow-origin");
  const siteDecidedCredentials = decidedBySite.includes("access-control-allow-credentials");
  const origin = request.headers.get("origin");
  if (!siteDecidedOrigin || !siteDecidedCredentials) response.headers.append("Vary", "Origin");
  if (!siteDecidedOrigin) response.headers.set("Access-Control-Allow-Origin", origin ?? "*");
  const originAllowed = origin !== null && response.headers.get("access-control-allow-origin") === origin;
  if (!siteDecidedCredentials && originAllowed) response.headers.set("Access-Control-Allow-Credentials", "true");
  if (!decidedBySite.includes("access-control-expose-headers")) response.headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
  if (!decidedBySite.includes("timing-allow-origin")) response.headers.set("Timing-Allow-Origin", "*");
  if (!decidedBySite.includes("cross-origin-resource-policy")) response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return response;
}

function allowOrigin(request: Request, headers: Headers): void {
  headers.append("Vary", "Origin");
  const origin = request.headers.get("origin");
  if (origin === null) {
    headers.set("Access-Control-Allow-Origin", "*");
    return;
  }
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
}
