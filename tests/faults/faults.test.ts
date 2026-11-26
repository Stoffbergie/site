import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { inject, test } from "vite-plus/test";
import { faultProxy, type Behavior } from "../helpers/faults";
import { baseUrl, deploy, folder, keyOf, newHome, runCli, siteDomain, uniqueName, visit, type Run } from "../helpers/site";

const cliPath = inject("cli");

type Timed = Run & { seconds: number };

function payload(): Record<string, string | Buffer> {
  return { "index.html": `<h1>${randomBytes(8).toString("hex")}</h1>`, "data.bin": randomBytes(300_000) };
}

async function through(behaviors: (connection: number) => Behavior, args: string[], home: string): Promise<Timed> {
  const proxy = await faultProxy(behaviors);
  const started = performance.now();
  try {
    const run = await runCli(args, { home, env: { SITE_URL: proxy.url } });
    return { ...run, seconds: (performance.now() - started) / 1000 };
  } finally {
    proxy.close();
  }
}

function assertPlainSentence(run: Run): void {
  assert.equal(run.code, 1, `expected a failure, got ${run.code}: ${run.stdout}`);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /^site: [^\n]+\n$/, `one line on stderr: ${JSON.stringify(run.stderr)}`);
  assert.doesNotMatch(run.stderr, /os error|io:|Error\(|panicked|\{/, `plain words only: ${run.stderr}`);
  assert.ok(run.stderr.length < 200, `short: ${run.stderr}`);
}

async function assertServes(url: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const reply = await visit(url, `/${path}`, { headers: { "accept-encoding": "identity" } });
    assert.equal(reply.status, 200, `${url}/${path}`);
    assert.ok(reply.body.equals(Buffer.from(contents)), `${url}/${path} has the deployed bytes`);
  }
}

async function assertEveryDeployServes(home: string): Promise<void> {
  const listed = await runCli(["ls"], { home });
  assert.equal(listed.code, 0, listed.stderr);
  for (const match of listed.stdout.matchAll(/(https?:\/\/[a-z0-9]{8}\.\S+)/g)) {
    assert.equal((await visit(match[1], "/data.bin", { headers: { "accept-encoding": "identity" } })).status, 200, `${match[1]} is whole`);
  }
}

async function namedSite(): Promise<{ home: string; name: string; files: Record<string, string | Buffer> }> {
  const home = newHome();
  const name = uniqueName("fault");
  const files = payload();
  await deploy(["--no-copy", "-n", name, folder(files)], { home });
  return { home, name, files };
}

function once(fault: Behavior): (connection: number) => Behavior {
  return (connection) => (connection === 1 ? fault : { kind: "pass" });
}

test("a connection dropped mid-upload is retried and the deploy lands", { timeout: 60_000 }, async () => {
  const { home, name } = await namedSite();
  const files = payload();
  const run = await through(once({ kind: "dropAfter", bytes: 100_000 }), ["--no-copy", "-n", name, folder(files)], home);
  assert.equal(run.code, 0, run.stderr);
  await assertServes(`https://${name}.${siteDomain}`, files);
  await assertEveryDeployServes(home);
});

test("a link that always drops ends in one sentence and leaves the name alone", { timeout: 90_000 }, async () => {
  const { home, name, files } = await namedSite();
  const run = await through(() => ({ kind: "dropAfter", bytes: 100_000 }), ["--no-copy", "-n", name, folder(payload())], home);
  assertPlainSentence(run);
  assert.ok(run.seconds < 60, `gave up in ${run.seconds}s`);
  await assertServes(`https://${name}.${siteDomain}`, files);
  await assertEveryDeployServes(home);
});

test("a 503 from the server is retried", { timeout: 60_000 }, async () => {
  const { home, name } = await namedSite();
  const files = payload();
  const run = await through(once({ kind: "respond", status: 503, body: "Service unavailable\n" }), ["--no-copy", "-n", name, folder(files)], home);
  assert.equal(run.code, 0, run.stderr);
  await assertServes(`https://${name}.${siteDomain}`, files);
});

test("a 429 is retried after Retry-After", { timeout: 60_000 }, async () => {
  const { home, name } = await namedSite();
  const files = payload();
  const run = await through(
    once({ kind: "respond", status: 429, headers: { "retry-after": "1" }, body: "Too many requests; try again in a minute.\n" }),
    ["--no-copy", "-n", name, folder(files)],
    home
  );
  assert.equal(run.code, 0, run.stderr);
  await assertServes(`https://${name}.${siteDomain}`, files);
});

test("a server that keeps failing ends in one sentence quickly", { timeout: 90_000 }, async () => {
  const { home, name, files } = await namedSite();
  const run = await through(() => ({ kind: "respond", status: 500, body: "Something went wrong; try again.\n" }), ["--no-copy", "-n", name, folder(payload())], home);
  assertPlainSentence(run);
  assert.ok(run.seconds < 60, `gave up in ${run.seconds}s`);
  await assertServes(`https://${name}.${siteDomain}`, files);
});

test("a link that stalls mid-upload is abandoned and retried", { timeout: 150_000 }, async () => {
  const { home, name } = await namedSite();
  const files = payload();
  const run = await through(once({ kind: "stallAfter", bytes: 100_000 }), ["--no-copy", "-n", name, folder(files)], home);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.seconds < 120, `recovered in ${run.seconds}s`);
  await assertServes(`https://${name}.${siteDomain}`, files);
});

test("a link that always stalls ends in one sentence instead of hanging", { timeout: 300_000 }, async () => {
  const { home, name, files } = await namedSite();
  const run = await through(() => ({ kind: "stallAfter", bytes: 100_000 }), ["--no-copy", "-n", name, folder(payload())], home);
  assertPlainSentence(run);
  assert.ok(run.seconds < 240, `gave up in ${run.seconds}s`);
  await assertServes(`https://${name}.${siteDomain}`, files);
});

test("a server that never answers ends in one sentence instead of hanging", { timeout: 300_000 }, async () => {
  const home = newHome();
  const run = await through(() => ({ kind: "blackhole" }), ["--no-copy", folder({ "index.html": "<h1>hi</h1>" })], home);
  assertPlainSentence(run);
  assert.ok(run.seconds < 240, `gave up in ${run.seconds}s`);
});

test("a slow link still deploys", { timeout: 120_000 }, async () => {
  const { home, name } = await namedSite();
  const files = payload();
  const run = await through(() => ({ kind: "throttle", bytesPerSecond: 12_000 }), ["--no-copy", "-n", name, folder(files)], home);
  assert.equal(run.code, 0, run.stderr);
  await assertServes(`https://${name}.${siteDomain}`, files);
});

test("a lost response is retried and the name ends on a working deploy", { timeout: 60_000 }, async () => {
  const { home, name } = await namedSite();
  const files = payload();
  const run = await through(once({ kind: "dropResponse" }), ["--no-copy", "-n", name, folder(files)], home);
  assert.equal(run.code, 0, run.stderr);
  await assertServes(`https://${name}.${siteDomain}`, files);
  await assertEveryDeployServes(home);
});

test("a duplicated upload leaves a working site", { timeout: 60_000 }, async () => {
  const { home, name } = await namedSite();
  const files = payload();
  const run = await through(once({ kind: "duplicate" }), ["--no-copy", "-n", name, folder(files)], home);
  assert.equal(run.code, 0, run.stderr);
  await assertServes(`https://${name}.${siteDomain}`, files);
  await assertEveryDeployServes(home);
});

test("a CLI killed mid-upload leaves no half deploy and the next deploy works", { timeout: 60_000 }, async () => {
  const { home, name, files } = await namedSite();
  const before = await runCli(["ls"], { home });
  const proxy = await faultProxy(() => ({ kind: "throttle", bytesPerSecond: 50_000 }));
  try {
    const child = spawn(cliPath, ["--no-copy", "-n", name, folder(payload())], { env: { ...process.env, SITE_URL: proxy.url, HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1" } });
    child.stdin.end();
    while (proxy.uploaded() < 100_000) await new Promise((resolve) => setTimeout(resolve, 50));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("close", resolve));
  } finally {
    proxy.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await runCli(["ls"], { home });
  assert.equal(after.stdout, before.stdout, "no new deploy appeared");
  await assertServes(`https://${name}.${siteDomain}`, files);
  const next = payload();
  await deploy(["--no-copy", "-n", name, folder(next)], { home });
  await assertServes(`https://${name}.${siteDomain}`, next);
});

test("concurrent deploys to one name with the same key all succeed", { timeout: 60_000 }, async () => {
  const { home, name } = await namedSite();
  const sites = [payload(), payload(), payload(), payload(), payload()];
  const runs = await Promise.all(sites.map((files) => runCli(["--no-copy", "-n", name, folder(files)], { home })));
  for (const run of runs) assert.equal(run.code, 0, run.stderr);
  const served = await visit(`https://${name}.${siteDomain}`, "/");
  assert.ok(
    sites.some((files) => files["index.html"] === served.text),
    "the name serves one of the deploys"
  );
  await assertEveryDeployServes(home);
});

test("two keys racing for a new name: one wins, the other is told plainly", { timeout: 60_000 }, async () => {
  const name = uniqueName("race");
  const runs = await Promise.all([runCli(["--no-copy", "-n", name, folder(payload())]), runCli(["--no-copy", "-n", name, folder(payload())])]);
  const winners = runs.filter((run) => run.code === 0);
  const losers = runs.filter((run) => run.code !== 0);
  assert.equal(winners.length, 1, runs.map((run) => run.stderr).join("\n"));
  assert.equal(losers[0].stderr, "site: that name is taken; pick another\n");
});

test("an interrupted download resumes with a range read", { timeout: 60_000 }, async () => {
  const files = payload();
  const { url } = await deploy(["--no-copy", folder(files)]);
  const host = new URL(url).hostname;
  const port = new URL(baseUrl).port;
  const partial = await new Promise<{ received: Buffer; etag: string }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: "/data.bin", headers: { host, "accept-encoding": "identity" } }, (response) => {
      let received = Buffer.alloc(0);
      response.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.byteLength >= 50_000) {
          request.destroy();
          resolve({ received, etag: response.headers.etag as string });
        }
      });
    });
    request.on("error", (error) => (error.message.includes("aborted") || error.message.includes("socket hang up") ? undefined : reject(error)));
    request.end();
  });
  const rest = await visit(url, "/data.bin", { headers: { range: `bytes=${partial.received.byteLength}-`, "if-range": partial.etag, "accept-encoding": "identity" } });
  assert.equal(rest.status, 206);
  assert.ok(Buffer.concat([partial.received, rest.body]).equals(files["data.bin"] as Buffer), "the pieces join into the file");
  const stale = await visit(url, "/data.bin", { headers: { range: "bytes=10-", "if-range": '"stale-0"', "accept-encoding": "identity" } });
  assert.equal(stale.status, 200);
  assert.ok(stale.body.equals(files["data.bin"] as Buffer));
});

test("listing through a flaky server is retried", { timeout: 60_000 }, async () => {
  const { home, name } = await namedSite();
  const run = await through(once({ kind: "respond", status: 502, body: "Bad gateway\n" }), ["ls"], home);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, new RegExp(name));
});

test("the key stays the same when every attempt fails", { timeout: 30_000 }, async () => {
  const home = newHome();
  const key = await keyOf(home);
  const run = await through(() => ({ kind: "respond", status: 503, body: "Service unavailable\n" }), ["--no-copy", folder(payload())], home);
  assert.equal(run.code, 1);
  assert.equal(await keyOf(home), key);
});
