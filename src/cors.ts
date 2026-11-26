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

export function openToOtherOrigins(request: Request, response: Response): Response {
  allowOrigin(request, response.headers);
  response.headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
  response.headers.set("Timing-Allow-Origin", "*");
  response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
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
