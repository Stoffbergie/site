import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inject } from "vite-plus/test";

export const baseUrl = inject("baseUrl");
export const siteDomain = inject("siteDomain");
export const adminToken = inject("adminToken");
const cliPath = inject("cli");
const serverPort = new URL(baseUrl).port;

export type Reply = { status: number; headers: IncomingHttpHeaders; body: Buffer; text: string };
export type Run = { code: number | null; stdout: string; stderr: string };

export function visit(url: string, path = "/", init: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const host = new URL(url).hostname;
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: serverPort, path, method: init.method ?? "GET", headers: { ...init.headers, host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body, text: body.toString("utf8") });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

export function upload(path: string, body: Buffer | string, headers: Record<string, string> = {}, method = "PUT"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(body);
    const request = httpRequest({ host: "127.0.0.1", port: serverPort, path, method, headers: { "content-length": String(bytes.byteLength), ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const responseBody = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: responseBody, text: responseBody.toString("utf8") });
      });
    });
    request.on("error", reject);
    request.end(bytes);
  });
}

export function runCli(args: string[], options: { home?: string; input?: string | Buffer; env?: Record<string, string> } = {}): Promise<Run> {
  const home = options.home ?? newHome();
  const env: Record<string, string> = { ...(process.env as Record<string, string>), SITE_URL: baseUrl, HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1", ...options.env };
  if (!options.env?.SITE_KEY) delete env.SITE_KEY;
  const child = spawn(cliPath, args, { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

export async function deploy(args: string[], options: { home?: string; input?: string | Buffer } = {}): Promise<{ url: string; label: string; run: Run }> {
  const run = await runCli(args, options);
  if (run.code !== 0) throw new Error(`site ${args.join(" ")} failed\n${run.stderr}`);
  const url = run.stdout.trim();
  return { url, label: new URL(url).hostname.split(".")[0], run };
}

export async function keyOf(home: string): Promise<string> {
  return (await runCli(["key"], { home })).stdout.trim();
}

export async function apiKeyOf(home: string): Promise<string> {
  return (await keyOf(home)).split(".")[0];
}

export function newHome(): string {
  return mkdtempSync(join(tmpdir(), "site-cli-"));
}

export function folder(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "site-files-"));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export function idUrl(id: string): string {
  return `https://${id}.${siteDomain}`;
}

export function browserUrl(link: string): string {
  const url = new URL(link);
  return `http://${url.hostname}:${serverPort}${url.pathname}${url.search}${url.hash}`;
}

export function hostOf(link: string): string {
  return link.split("#")[0].replace(/\/$/, "");
}
