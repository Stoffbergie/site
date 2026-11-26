import { Hono, type Context } from "hono";
import type { Env } from "./env";
import { isDeployId, isSiteKey, nameProblem } from "./names";
import { homePage, homeText, notFoundPage } from "./pages";
import {
  deployKey,
  encryptedName,
  isEncrypted,
  MAX_NAMES,
  namesPointingAt,
  ownedDeploys,
  ownedNames,
  readPointer,
  readPointerRecord,
  releasePointer,
  removeDeploy,
  storeDeploy,
  writePointer,
  type Stored
} from "./storage";

type AppContext = Context<{ Bindings: Env }>;
type Caller = { kind: "admin" } | { kind: "key"; owner: string } | { kind: "anonymous" } | { kind: "invalid" };
type Claim = { etag: string | null; pointedId: string | null };

type Pointing = "pointed" | "lost" | "holds encrypted";

const RELEASED_BY_ADMIN = "admin";
const POINTER_ATTEMPTS = 5;

export const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
});

app.onError((error) => {
  console.error(error);
  return text("Something went wrong; try again.\n", 500);
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

app.put("/:filename", (c) => deploy(c, c.req.param("filename")));

app.notFound(async (c) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    if (asset.status !== 404) return asset;
  }
  if (wantsHtml(c.req.raw.headers)) return c.html(notFoundPage(), 404);
  return text("Not found\n", 404);
});

async function deploy(c: AppContext, filename: string): Promise<Response> {
  if (!(await allowed(c, c.env.DEPLOYS))) return tooMany();
  const caller = await identify(c);
  if (caller.kind === "invalid") return needsKey(caller);
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

  const result = await storeDeploy(c.env, c.req.raw, filename, owner);
  if ("problem" in result) return text(`${result.problem}\n`, result.status);
  const stored = result.stored;

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
  const presented = authorization.slice(7).trim();
  const token = c.env.SITE_TOKEN;
  if (token && same(presented, token)) return { kind: "admin" };
  if (!isSiteKey(presented)) return { kind: "invalid" };
  return { kind: "key", owner: await sha256(presented) };
}

function needsKey(caller: Caller): Response {
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
  return (await limiter.limit({ key: address })).success;
}

function siteUrl(label: string, domain: string): string {
  return `https://${label}.${domain}`;
}

function wantsHtml(headers: Headers): boolean {
  const crawler = /WhatsApp|facebookexternalhit|Facebot|meta-externalagent|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|Googlebot|bingbot/i;
  return (headers.get("accept") ?? "").includes("text/html") || crawler.test(headers.get("user-agent") ?? "");
}

function tooMany(): Response {
  return text("Too many requests; try again in a minute.\n", 429, { "Retry-After": "60" });
}

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}
