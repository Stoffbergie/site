import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inject, test } from "vite-plus/test";
import { newHome, runCli } from "../helpers/site";

type Expected = { args: string[]; code: number; stdout: string; stderr: string };

const expected = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/arguments.json"), "utf8")) as Expected[];

test("every command, flag, help page and argument error prints what the clap-based CLI printed", { timeout: 120_000 }, async () => {
  for (const { args, code, stdout, stderr } of expected) {
    const run = await runCli(args);
    const label = `site ${args.join(" ")}`;
    assert.equal(run.stdout, stdout, label);
    assert.equal(run.stderr, stderr, label);
    assert.equal(run.code, code, label);
  }
});

test("an argument that is not UTF-8 prints the argument error the clap-based CLI printed", () => {
  const rootUsage = "Usage: site [OPTIONS] [PATHS]...\n       site <COMMAND>";
  const cases = [
    { args: '-- "$(printf "a\\377")"', usage: rootUsage },
    { args: '"$(printf "a\\377")"', usage: rootUsage },
    { args: '-n "$(printf "a\\377")" dist', usage: rootUsage },
    { args: 'rm "$(printf "a\\377")"', usage: "Usage: site rm <TARGET>" },
    { args: 'point "$(printf "a\\377")" abc', usage: "Usage: site point <NAME> <ID>" },
    { args: 'key "$(printf "a\\377")"', usage: "Usage: site key [KEY]" }
  ];
  for (const { args, usage } of cases) {
    const run = spawnSync("/bin/sh", ["-c", `exec "$SITE_CLI" ${args}`], { env: { ...process.env, SITE_CLI: inject("cli"), HOME: newHome() }, encoding: "utf8" });
    assert.equal(run.stdout, "", args);
    assert.equal(run.stderr, `error: invalid UTF-8 was detected in one or more arguments\n\n${usage}\n\nFor more information, try '--help'.\n`, args);
    assert.equal(run.status, 2, args);
  }
});
