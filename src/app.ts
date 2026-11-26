import { Hono, type Context } from "hono";
import type { Env } from "./env";
import { isDeployId, isSiteKey, nameProblem, newNameProblem } from "./names";
import { homePage, homeText, notFoundPage } from "./pages";
import {
  blockedKey,
  deployKey,
  encryptedName,
  holdsTooMuch,
  isEncrypted,
  MAX_DEPLOYS,
  MAX_NAMES,
  namesPointingAt,
  ownedDeploys,
  ownedNames,
  readPointer,
  readPointerRecord,
  releasePointer,
  removeDeploy,
  removeDeploys,
  storeDeploy,
  writePointer,
  type Stored
} from "./storage";

type AppContext = Context<{ Bindings: Env }>;
type Caller = { kind: "admin" } | { kind: "key"; owner: string } | { kind: "anonymous" } | { kind: "invalid" } | { kind: "blocked" };
type Claim = { etag: string | null; pointedId: string | null };

type Pointing = "pointed" | "lost" | "holds encrypted";

const RELEASED_BY_ADMIN = "admin";
const POINTER_ATTEMPTS = 5;
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};
const BULK_DEPLOY_BYTES = 10_000_000;
const IPV6_GROUPS = 8;
const IPV6_NETWORK_GROUPS = 4;
const OWNER_PATTERN = /^[0-9a-f]{64}$/;

export const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
});

app.onError((error) => {
  console.error(error);
  return text("Something went wrong; try again.\n", 500, SECURITY_HEADERS);
});

app.get("/", (c) => {
  const origin = new URL(c.req.url).origin;
  if (wantsHtml(c.req.raw.headers)) return c.html(homePage(origin, c.env.SITE_DOMAIN));
  return text(homeText(origin, c.env.SITE_DOMAIN));
});

app.get("/robots.txt", (c) => text(`User-agent: *\nAllow: /\nSitemap: ${new URL(c.req.url).origin}/sitemap.xml\n`));

app.get("/sitemap.xml", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>`, 200, {
    "Content-Type": "application/xml; charset=utf-8"
  });
});

app.post("/", (c) => deploy(c, "index.html"));
app.put("/", (c) => deploy(c, "index.html"));

app.get("/list", async (c) => {
  if (!(await allowed(c, c.env.LOOKUPS))) return tooMany();
  const caller = await identify(c);
  if (caller.kind !== "key") return needsKey(caller);
  const [names, deploys] = await Promise.all([ownedNames(c.env, caller.owner), ownedDeploys(c.env, caller.owner)]);
  const pointers = await Promise.all(names.map((name) => readPointer(c.env, name)));
  const newestFirst = deploys.sort((left, right) => right.uploaded.getTime() - left.uploaded.getTime());
  const encryptedIds = new Set(deploys.filter((object) => isEncrypted(object)).map((object) => idOf(object)));
  return Response.json({
    names: names.map((name, position) => {
      const id = pointers[position]?.id ?? null;
      return { name, url: siteUrl(name, c.env.SITE_DOMAIN), id, encrypted: id !== null && encryptedIds.has(id) };
    }),
    deploys: newestFirst.map((object) => {
      const id = idOf(object);
      return {
        id,
        url: siteUrl(id, c.env.SITE_DOMAIN),
        createdAt: object.uploaded.toISOString(),
        size: Number(object.customMetadata?.size ?? 0),
        files: Number(object.customMetadata?.files ?? 0),
        encrypted: linkHintOf(object)
      };
    })
  });
});

app.put("/names/:name", async (c) => {
  if (!(await allowed(c, c.env.DEPLOYS))) return tooMany();
  const caller = await identify(c);
  if (caller.kind !== "key") return needsKey(caller);
  const name = c.req.param("name");
  const body = await c.req.json<{ id?: unknown }>().catch(() => ({ id: undefined }));
  const id = typeof body.id === "string" ? body.id : "";
  const claim = await prepareClaim(c, name, caller.owner);
  if (claim instanceof Response) return claim;
  const target = isDeployId(id) ? await c.env.SITES.head(deployKey(id)) : null;
  if (!target || target.customMetadata?.owner !== caller.owner) return text(`You have no deploy ${id}; run site ls to see yours.\n`, 404);
  const targetEncrypted = isEncrypted(target);
  if (targetEncrypted && encryptedName(target) !== name) {
    return text(`${id} was encrypted for its own link, so the link for ${name} could not open it; deploy again with site -e -n ${name}.\n`, 409);
  }
  if (!targetEncrypted && (await holdsEncrypted(c, claim.pointedId))) {
    return text(`${name} holds an encrypted site; point it at a deploy encrypted for ${name}, or release it with site rm ${name} first.\n`, 409);
  }
  if (!(await writePointer(c.env, name, caller.owner, id, claim.etag))) return text("That name changed while pointing it; try again.\n", 409);
  const headers: Record<string, string> = {};
  if (targetEncrypted) headers["X-Site-Encrypted"] = "true";
  return text(`${siteUrl(name, c.env.SITE_DOMAIN)}\n`, 200, headers);
});

app.delete("/names/:name", async (c) => {
  if (!(await allowed(c, c.env.LOOKUPS))) return tooMany();
  const caller = await identify(c);
  if (caller.kind !== "key" && caller.kind !== "admin") return needsKey(caller);
  const name = c.req.param("name");
  const record = await readPointerRecord(c.env, name);
  if (!record?.pointer) return text(`No name ${name}; run site ls to see yours.\n`, 404);
  if (caller.kind === "key" && record.pointer.owner !== caller.owner) return text("That name belongs to another key.\n", 403);
  let releasedBy = RELEASED_BY_ADMIN;
  if (caller.kind === "key") releasedBy = caller.owner;
  if (!(await releasePointer(c.env, name, record.pointer.owner, releasedBy, record.etag))) return text("That name changed while releasing it; try again.\n", 409);
  return text("released\n");
});

app.delete("/deploys/:id", async (c) => {
  if (!(await allowed(c, c.env.LOOKUPS))) return tooMany();
  const caller = await identify(c);
  if (caller.kind !== "key" && caller.kind !== "admin") return needsKey(caller);
  const id = c.req.param("id");
  const object = isDeployId(id) ? await c.env.SITES.head(deployKey(id)) : null;
  if (!object) return text(`No deploy ${id}; run site ls to see yours.\n`, 404);
  const owner = object.customMetadata?.owner;
  if (caller.kind === "key" && owner !== caller.owner) return text("That deploy belongs to another key.\n", 403);
  if (owner) {
    const names = await namesPointingAt(c.env, owner, id);
    if (names.length > 0) {
      const listed = names.join(", ");
      return text(`${listed} still points at ${id}; point it at another deploy or release it with site rm ${names[0]} first.\n`, 409);
    }
  }
  await removeDeploy(c.env, id, owner);
  return text("deleted\n");
});

app.get("/deploys/:id", async (c) => {
  if (!isAdmin(c)) return c.notFound();
  const id = c.req.param("id");
  const object = isDeployId(id) ? await c.env.SITES.head(deployKey(id)) : null;
  if (!object) return text(`No deploy ${id}.\n`, 404);
  return Response.json({
    id,
    owner: object.customMetadata?.owner ?? null,
    size: Number(object.customMetadata?.size ?? 0),
    files: Number(object.customMetadata?.files ?? 0),
    createdAt: object.uploaded.toISOString(),
    encrypted: linkHintOf(object)
  });
});

app.get("/names/:name", async (c) => {
  if (!isAdmin(c)) return c.notFound();
  const name = c.req.param("name");
  const record = await readPointerRecord(c.env, name);
  if (!record) return text(`No name ${name}.\n`, 404);
  return Response.json({ name, id: record.pointer?.id ?? null, owner: record.pointer?.owner ?? null, releasedBy: record.releasedBy });
});

app.on(["PUT", "DELETE"], "/blocked/:owner", async (c) => {
  if (!isAdmin(c)) return c.notFound();
  const owner = c.req.param("owner");
  if (!OWNER_PATTERN.test(owner)) return badOwner();
  if (c.req.method === "PUT") {
    await c.env.SITES.put(blockedKey(owner), "");
    return text("blocked\n");
  }
  await c.env.SITES.delete(blockedKey(owner));
  return text("unblocked\n");
});

app.delete("/owners/:owner", async (c) => {
  if (!isAdmin(c)) return c.notFound();
  const owner = c.req.param("owner");
  if (!OWNER_PATTERN.test(owner)) return badOwner();
  const names = await ownedNames(c.env, owner);
  for (const name of names) {
    const record = await readPointerRecord(c.env, name);
    if (record?.pointer?.owner !== owner) continue;
    if (!(await releasePointer(c.env, name, owner, RELEASED_BY_ADMIN, record.etag))) return text(`${name} changed while releasing it; try again.\n`, 409);
  }
  const ids = (await ownedDeploys(c.env, owner)).map((object) => idOf(object));
  await removeDeploys(c.env, owner, ids);
  return text(`Removed ${ids.length} deploys and released ${names.length} names.\n`);
});

app.put("/:filename", (c) => deploy(c, c.req.param("filename")));

app.notFound(async (c) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    if (asset.status !== 404) return new Response(asset.body, asset);
  }
  if (wantsHtml(c.req.raw.headers)) return c.html(notFoundPage(), 404);
  return text("Not found\n", 404);
});

async function deploy(c: AppContext, filename: string): Promise<Response> {
  if (!(await allowed(c, c.env.DEPLOYS))) return tooMany();
  const caller = await identify(c);
  if (caller.kind === "invalid" || caller.kind === "blocked") return needsKey(caller);
  let owner: string | null = null;
  if (caller.kind === "key") owner = caller.owner;

  const name = c.req.query("name");
  let claim: Claim | null = null;
  if (name !== undefined) {
    if (owner === null) return text("Naming a site needs your key; deploy with the site CLI or send Authorization: Bearer <key>.\n", 401);
    const prepared = await prepareClaim(c, name, owner);
    if (prepared instanceof Response) return prepared;
    claim = prepared;
  }
  if (owner !== null && (await holdsTooMuch(c.env, owner))) {
    return text(`A key can hold ${MAX_DEPLOYS} deploys and 5 GB; remove some with site rm <id> first.\n`, 403);
  }

  const admitStoredBytes = async (storedBytes: number): Promise<boolean> => {
    if (storedBytes <= BULK_DEPLOY_BYTES) return true;
    return allowed(c, c.env.BULK);
  };
  const result = await storeDeploy(c.env, c.req.raw, filename, owner, admitStoredBytes);
  if ("problem" in result && result.status === 429) return tooMany();
  if ("problem" in result) return text(`${result.problem}\n`, result.status);
  const stored = result.stored;
  if (owner !== null && (await c.env.SITES.head(blockedKey(owner)))) {
    await removeDeploy(c.env, stored.id, owner);
    return needsKey({ kind: "blocked" });
  }

  if (name !== undefined && claim !== null && owner !== null) {
    if (stored.encrypted !== null && stored.encrypted.name !== name) {
      await removeDeploy(c.env, stored.id, owner);
      return text(`This deploy was encrypted for another link; deploy with site -e -n ${name}.\n`, 400);
    }
    if (stored.encrypted === null && (await holdsEncrypted(c, claim.pointedId))) {
      await removeDeploy(c.env, stored.id, owner);
      return text(`${name} holds an encrypted site; deploy with -e to keep it private, or release it with site rm ${name} first.\n`, 409);
    }
    const pointing = await pointName(c, name, owner, stored.id, claim, stored.encrypted !== null);
    if (pointing === "holds encrypted") {
      await removeDeploy(c.env, stored.id, owner);
      return text(`${name} holds an encrypted site; deploy with -e to keep it private, or release it with site rm ${name} first.\n`, 409);
    }
    if (pointing === "lost") {
      await removeDeploy(c.env, stored.id, owner);
      return text("That name is taken; pick another.\n", 409);
    }
  }
  return deployed(c, stored, name);
}

async function pointName(c: AppContext, name: string, owner: string, id: string, claim: Claim, encrypted: boolean): Promise<Pointing> {
  let expected = claim.etag;
  for (let attempt = 0; attempt < POINTER_ATTEMPTS; attempt += 1) {
    if (await writePointer(c.env, name, owner, id, expected)) return "pointed";
    const current = await readPointerRecord(c.env, name);
    if (current === null || current.pointer?.owner !== owner) return "lost";
    if (!encrypted && (await holdsEncrypted(c, current.pointer.id))) return "holds encrypted";
    expected = current.etag;
  }
  return "lost";
}

async function prepareClaim(c: AppContext, name: string, owner: string): Promise<Claim | Response> {
  const problem = nameProblem(name);
  if (problem !== null) return text(`${problem}\n`, 400);
  const record = await readPointerRecord(c.env, name);
  if (record?.pointer) {
    if (record.pointer.owner !== owner) return text("That name is taken; pick another.\n", 409);
    return { etag: record.etag, pointedId: record.pointer.id };
  }
  const newProblem = newNameProblem(name);
  if (newProblem !== null) return text(`${newProblem}\n`, 400);
  if (record && record.releasedBy !== owner) return text("That name is taken; pick another.\n", 409);
  const names = await ownedNames(c.env, owner);
  if (names.length >= MAX_NAMES) return text(`A key can hold ${MAX_NAMES} names; release one with site rm <name> first.\n`, 403);
  return { etag: record?.etag ?? null, pointedId: null };
}

async function holdsEncrypted(c: AppContext, id: string | null): Promise<boolean> {
  if (id === null) return false;
  const object = await c.env.SITES.head(deployKey(id));
  return object !== null && isEncrypted(object);
}

function idOf(object: R2Object): string {
  return object.key.split("/").pop() ?? "";
}

function linkHintOf(object: R2Object): { name: string } | { linkSalt: string } | null {
  const name = encryptedName(object);
  if (name !== null) return { name };
  const linkSalt = object.customMetadata?.linkSalt;
  if (linkSalt !== undefined) return { linkSalt };
  return null;
}

function deployed(c: AppContext, stored: Stored, name: string | undefined): Response {
  const url = siteUrl(stored.id, c.env.SITE_DOMAIN);
  const headers: Record<string, string> = { "X-Site-Id": stored.id, "X-Site-Url": url };
  let nameUrl: string | null = null;
  if (name !== undefined) {
    nameUrl = siteUrl(name, c.env.SITE_DOMAIN);
    headers["X-Site-Name-Url"] = nameUrl;
  }
  if (c.req.header("accept")?.includes("application/json")) {
    return Response.json({ id: stored.id, url, name: name ?? null, nameUrl, files: stored.files, size: stored.size }, { status: 201, headers });
  }
  return text(`${nameUrl ?? url}\n`, 201, headers);
}

async function identify(c: AppContext): Promise<Caller> {
  const authorization = c.req.header("authorization");
  if (!authorization) return { kind: "anonymous" };
  if (!authorization.startsWith("Bearer ")) return { kind: "invalid" };
  if (isAdmin(c)) return { kind: "admin" };
  const presented = authorization.slice(7).trim();
  if (!isSiteKey(presented)) return { kind: "invalid" };
  const owner = await sha256(presented);
  if (await c.env.SITES.head(blockedKey(owner))) return { kind: "blocked" };
  return { kind: "key", owner };
}

function isAdmin(c: AppContext): boolean {
  const authorization = c.req.header("authorization");
  const token = c.env.SITE_TOKEN;
  if (!token || !authorization?.startsWith("Bearer ")) return false;
  return same(authorization.slice(7).trim(), token);
}

function needsKey(caller: Caller): Response {
  if (caller.kind === "blocked") return text("This key is blocked for abuse; report a mistake at https://github.com/Stoffbergie/site/issues.\n", 403);
  if (caller.kind === "invalid") return text("That is not a site key; run site key to see yours.\n", 401);
  return text("This needs your key; use the site CLI or send Authorization: Bearer <key>.\n", 401);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function same(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

async function allowed(c: AppContext, limiter: RateLimit): Promise<boolean> {
  const address = c.req.header("cf-connecting-ip");
  if (!address) return true;
  return (await limiter.limit({ key: clientKey(address) })).success;
}

function clientKey(address: string): string {
  if (!address.includes(":")) return address;
  return `${ipv6Network(address)}::/64`;
}

function ipv6Network(address: string): string {
  const [before, after] = address.toLowerCase().split("::");
  const leading = groupsOf(before);
  const trailing = groupsOf(after);
  const missing = Math.max(0, IPV6_GROUPS - widthOf(leading) - widthOf(trailing));
  const groups = [...leading, ...Array<string>(missing).fill("0"), ...trailing];
  return groups
    .slice(0, IPV6_NETWORK_GROUPS)
    .map((group) => parseInt(group, 16).toString(16))
    .join(":");
}

function groupsOf(part: string | undefined): string[] {
  if (!part) return [];
  return part.split(":");
}

function widthOf(groups: string[]): number {
  const embeddedIpv4 = groups.at(-1)?.includes(".") ?? false;
  if (embeddedIpv4) return groups.length + 1;
  return groups.length;
}

function siteUrl(label: string, domain: string): string {
  return `https://${label}.${domain}`;
}

function wantsHtml(headers: Headers): boolean {
  const crawler = /WhatsApp|facebookexternalhit|Facebot|meta-externalagent|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|Googlebot|bingbot/i;
  return (headers.get("accept") ?? "").includes("text/html") || crawler.test(headers.get("user-agent") ?? "");
}

function badOwner(): Response {
  return text("An owner is the 64 lowercase hex characters of a key's SHA-256.\n", 400);
}

function tooMany(): Response {
  return text("Too many requests; try again in a minute.\n", 429, { "Retry-After": "60" });
}

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}
