import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { cloudflare } from "@cloudflare/vite-plugin";
import { createServer } from "vite-plus";
import type { TestProject } from "vite-plus/test/node";

declare module "vite-plus/test" {
  export interface ProvidedContext {
    baseUrl: string;
    siteDomain: string;
    adminToken: string;
    cli: string;
  }
}

const siteDomain = "site.test";
const adminToken = "test-admin-token";
const testLimits = [
  { name: "DEPLOYS", namespace_id: "2006", simple: { limit: 100_000, period: 60 as const } },
  { name: "LOOKUPS", namespace_id: "2007", simple: { limit: 100_000, period: 60 as const } }
];

export default async function startWorker(project: TestProject): Promise<() => Promise<void>> {
  execFileSync("cargo", ["build", "--quiet", "--manifest-path", "cli/Cargo.toml"], { stdio: "inherit" });
  const server = await createServer({
    configFile: false,
    logLevel: "error",
    plugins: [
      cloudflare({
        persistState: false,
        config: (workerConfig) => {
          workerConfig.vars = { ...workerConfig.vars, SITE_DOMAIN: siteDomain, SITE_TOKEN: adminToken };
          workerConfig.ratelimits = testLimits;
        }
      })
    ],
    server: { host: "127.0.0.1", port: 0, allowedHosts: true }
  });
  await server.listen();
  const address = server.httpServer?.address() as AddressInfo;
  project.provide("baseUrl", `http://127.0.0.1:${address.port}`);
  project.provide("siteDomain", siteDomain);
  project.provide("adminToken", adminToken);
  project.provide("cli", `${process.cwd()}/cli/target/debug/site`);
  return () => server.close();
}
