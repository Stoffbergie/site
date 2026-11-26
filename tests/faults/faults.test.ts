import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { inject, test } from "vite-plus/test";
import { faultProxy, type Behavior } from "../helpers/faults";
import { apiKeyOf, baseUrl, deploy, folder, keyOf, newHome, runCli, siteDomain, uniqueName, upload, visit, type Run } from "../helpers/site";

const cliPath = inject("cli");

type Timed = Run & { seconds: number };

function payload(): Record<string, string | Buffer> {
  return { "index.html": `<h1>${randomBytes(8).toString("hex")}</h1>`, "data.bin": randomBytes(300_000) };
}

function largerThanSocketBuffers(): Record<string, string | Buffer> {
  return { "index.html": `<h1>${randomBytes(8).toString("hex")}</h1>`, "data.bin": randomBytes(12_000_000) };
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
  const files = largerThanSocketBuffers();
  const run = await through(once({ kind: "stallAfter", bytes: 100_000 }), ["--no-copy", "-n", name, folder(files)], home);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.seconds < 120, `recovered in ${run.seconds}s`);
  await assertServes(`https://${name}.${siteDomain}`, files);
});

test("a link that always stalls ends in one sentence instead of hanging", { timeout: 300_000 }, async () => {
  const { home, name, files } = await namedSite();
  const run = await through(() => ({ kind: "stallAfter", bytes: 100_000 }), ["--no-copy", "-n", name, folder(largerThanSocketBuffers())], home);
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

test("a retried private deploy resends exactly the bytes of the first attempt, even when a file changed in between", { timeout: 60_000 }, async () => {
  const home = newHome();
  const files = payload();
  const root = folder(files);
  const plan = (connection: number): Behavior => {
    if (connection === 1) return { kind: "dropAfter", bytes: 150_000 };
    if (connection === 2) writeFileSync(join(root, "data.bin"), randomBytes(300_000));
    return { kind: "pass" };
  };
  const proxy = await faultProxy(plan);
  try {
    const run = await runCli(["--no-copy", "-e", root], { home, env: { SITE_URL: proxy.url } });
    assert.equal(run.code, 0, run.stderr);
    const first = proxy.received(1);
    const second = proxy.received(2);
    assert.ok(first.byteLength >= 150_000, `the first attempt got far: ${first.byteLength}`);
    assert.ok(second.subarray(0, first.byteLength).equals(first), "the retry repeats the first attempt byte for byte, so no nonce seals two plaintexts");
  } finally {
    proxy.close();
  }
});

test("a file rebuilt while it is being sent is remembered by the bytes that were sent", { timeout: 90_000 }, async () => {
  const home = newHome();
  const original = randomBytes(6_000_000);
  const root = folder({ "index.html": "<h1>rebuilt</h1>", "data.bin": original });
  const plan = (connection: number): Behavior => {
    if (connection > 1) return { kind: "pass" };
    setTimeout(() => writeFileSync(join(root, "data.bin"), randomBytes(6_000_000)), 2000);
    return { kind: "throttle", bytesPerSecond: 300_000 };
  };
  const proxy = await faultProxy(plan);
  try {
    const first = await runCli(["--no-copy", root], { home, env: { SITE_URL: proxy.url } });
    assert.equal(first.code, 0, first.stderr);
    writeFileSync(join(root, "data.bin"), original);
    const second = await runCli(["--no-copy", root], { home, env: { SITE_URL: proxy.url } });
    assert.equal(second.code, 0, second.stderr);
    await assertServes(second.stdout.trim(), { "data.bin": original });
  } finally {
    proxy.close();
  }
});

test("a cut-off answer to site point is a failure, not a blank link", { timeout: 60_000 }, async () => {
  const { home, name } = await namedSite();
  const { label } = await deploy(["--no-copy", folder(payload())], { home });
  const run = await through(() => ({ kind: "cutResponse", status: 200, body: "https://", declaredLength: 64, hang: false }), ["point", name, label], home);
  assertPlainSentence(run);
});

test("an answer whose body never arrives ends in one sentence instead of hanging", { timeout: 150_000 }, async () => {
  const { home } = await namedSite();
  const run = await through(() => ({ kind: "cutResponse", status: 200, body: '{"names":', declaredLength: 4096, hang: true }), ["ls"], home);
  assertPlainSentence(run);
  assert.ok(run.seconds < 120, `gave up in ${run.seconds}s`);
});

test("a release whose answer is lost is never replayed over a newer claim", { timeout: 150_000 }, async () => {
  const { home, name } = await namedSite();
  const next = payload();
  const { label } = await deploy(["--no-copy", folder(next)], { home });
  let reclaimed: Promise<Run> | null = null;
  const plan = (connection: number): Behavior => {
    if (connection > 1) return { kind: "pass" };
    return { kind: "forwardThenHold", forwarded: () => (reclaimed = runCli(["point", name, label], { home })) };
  };
  const run = await through(plan, ["rm", name], home);
  assert.ok(reclaimed !== null, "the release reached the server");
  const claim = await (reclaimed as Promise<Run>);
  assert.equal(claim.code, 0, claim.stderr);
  assertPlainSentence(run);
  await assertServes(`https://${name}.${siteDomain}`, next);
});

test("a slow link that takes longer than the watchdog to deliver a small upload still deploys", { timeout: 200_000 }, async () => {
  const home = newHome();
  const files = { "data.bin": randomBytes(120_000) };
  const run = await through(() => ({ kind: "throttle", bytesPerSecond: 1500 }), ["--no-copy", folder(files)], home);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.seconds > 70, `the link really was slow: ${run.seconds}s`);
  await assertServes(run.stdout.trim(), files);
});

test("a name repointed while another update races it never ends on a deleted deploy", { timeout: 120_000 }, async () => {
  const home = newHome();
  const key = await apiKeyOf(home);
  const name = uniqueName("gone");
  const { label: kept } = await deploy(["--no-copy", "-n", name, folder({ "index.html": "<h1>kept</h1>" })], { home });
  const authorization = `Bearer ${key}`;
  const pointAt = (id: string) => fetch(`${baseUrl}/names/${name}`, { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ id }) });
  for (let round = 0; round < 40; round += 1) {
    const stored = await upload("/index.html", `<h1>doomed ${round}</h1>`, { authorization, accept: "application/json" });
    const doomed = (JSON.parse(stored.text) as { id: string }).id;
    await Promise.all([pointAt(doomed), pointAt(kept), fetch(`${baseUrl}/deploys/${doomed}`, { method: "DELETE", headers: { authorization } })]);
    const served = await visit(`https://${name}.${siteDomain}`, "/");
    assert.equal(served.status, 200, `round ${round}: the name serves a deploy that exists`);
    await pointAt(kept);
  }
});

test("a cut-off answer to site rm is a failure, not a release", { timeout: 60_000 }, async () => {
  const { home, name } = await namedSite();
  const run = await through(() => ({ kind: "cutResponse", status: 200, body: "rel", declaredLength: 64, hang: false }), ["rm", name], home);
  assertPlainSentence(run);
});

function hangingResolver(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "site-resolver-"));
  const source = join(root, "hang.c");
  writeFileSync(
    source,
    `#include <netdb.h>
#include <unistd.h>
static int hang(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **found) {
  for (;;) sleep(1000);
  return 0;
}
#ifdef __APPLE__
__attribute__((used)) static struct { const void *replacement; const void *original; } interposed[] __attribute__((section("__DATA,__interpose"))) = { { (const void *)hang, (const void *)getaddrinfo } };
#else
int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **found) { return hang(node, service, hints, found); }
#endif
`
  );
  if (process.platform === "darwin") {
    const library = join(root, "hang.dylib");
    execFileSync("cc", ["-dynamiclib", "-o", library, source]);
    return { DYLD_INSERT_LIBRARIES: library };
  }
  const library = join(root, "hang.so");
  execFileSync("cc", ["-shared", "-fPIC", "-o", library, source]);
  return { LD_PRELOAD: library };
}

test("a name lookup that never answers ends in one sentence instead of hanging", { timeout: 200_000 }, async () => {
  const { home } = await namedSite();
  const port = new URL(baseUrl).port;
  const started = performance.now();
  const run = await runCli(["ls"], { home, env: { SITE_URL: `http://lookup-hangs.invalid:${port}`, ...hangingResolver() } });
  const seconds = (performance.now() - started) / 1000;
  assertPlainSentence(run);
  assert.ok(seconds < 150, `gave up in ${seconds}s`);
});

test("spooled files and ciphertext never show in the temporary folder, even when the CLI is killed", { timeout: 90_000 }, async () => {
  const home = newHome();
  const temporary = mkdtempSync(join(tmpdir(), "site-temporary-"));
  const files = { "index.html": "<h1>spooled</h1>", "data.bin": randomBytes(6_000_000) };
  const temporaryEnv = { TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  const proxy = await faultProxy(() => ({ kind: "throttle", bytesPerSecond: 500_000 }));
  try {
    const child = spawn(cliPath, ["--no-copy", "-e", folder(files)], { env: { ...process.env, SITE_URL: proxy.url, HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1", ...temporaryEnv } });
    child.stdin.end();
    while (proxy.uploaded() < 1_000_000) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(readdirSync(temporary), [], "nothing is linked in the temporary folder during the upload");
    const descriptors = `/proc/${child.pid}/fd`;
    if (existsSync(descriptors)) {
      for (const descriptor of readdirSync(descriptors)) {
        if (!readlinkSync(join(descriptors, descriptor)).startsWith(temporary)) continue;
        assert.equal(statSync(join(descriptors, descriptor)).mode & 0o777, 0o600, "only the owner can read a spool");
      }
    }
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("close", resolve));
  } finally {
    proxy.close();
  }
  assert.deepEqual(readdirSync(temporary), [], "a killed CLI leaves nothing behind");
  const run = await runCli(["--no-copy", "-e", folder(files)], { home, env: temporaryEnv });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(readdirSync(temporary), [], "a finished CLI leaves nothing behind");
});

function withSmallFileLimit(args: string[], input: Buffer): Promise<Run> {
  const home = newHome();
  const script = 'ulimit -f 2000; trap "" XFSZ; exec "$0" "$@"';
  const child = spawn("/bin/sh", ["-c", script, cliPath, ...args], { env: { ...process.env, SITE_URL: baseUrl, HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1" } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.on("error", () => undefined);
  child.stdin.end(input);
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

test("a private deploy that runs out of temporary space says so", { timeout: 60_000 }, async () => {
  const run = await withSmallFileLimit(["--no-copy", "-e", "-"], randomBytes(8_000_000));
  assertPlainSentence(run);
  assert.match(run.stderr, /temporary/);
});

test("an oversized private deploy is refused before its ciphertext is written", { timeout: 60_000 }, async () => {
  const run = await withSmallFileLimit(["--no-copy", "-e", "-"], randomBytes(101_000_000));
  assertPlainSentence(run);
  assert.match(run.stderr, /the limit is 100 MB/);
});
