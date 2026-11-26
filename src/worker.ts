import { app } from "./app";
import { openToOtherOrigins, preflight } from "./cors";
import type { Env } from "./env";
import { siteLabel } from "./names";
import { serveSite } from "./serve";

export default {
  async fetch(request, env, ctx) {
    const label = siteLabel(new URL(request.url).hostname, env.SITE_DOMAIN);
    if (label === null) return app.fetch(request, env, ctx);
    if (request.method === "OPTIONS") return preflight(request);
    return openToOtherOrigins(request, await serveSite(request, env, ctx, label));
  }
} satisfies ExportedHandler<Env>;
