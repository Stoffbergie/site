import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Route = { pattern: string };
type BuiltConfig = { name: string; routes?: Route[]; vars?: { SITE_DOMAIN?: string } };

const [expectedWorker, expectedDomain] = process.argv.slice(2);
const redirectPath = resolve(".wrangler/deploy/config.json");
const redirect = JSON.parse(readFileSync(redirectPath, "utf8")) as { configPath: string };
const built = JSON.parse(readFileSync(resolve(dirname(redirectPath), redirect.configPath), "utf8")) as BuiltConfig;
const builtDomain = built.vars?.SITE_DOMAIN;
const servesDomain = (built.routes ?? []).some((route) => route.pattern === expectedDomain);

if (built.name !== expectedWorker || builtDomain !== expectedDomain || !servesDomain) {
  console.error(`Refusing to deploy: this build is for the Worker ${built.name} at ${builtDomain}, not ${expectedWorker} at ${expectedDomain}.`);
  process.exit(1);
}
