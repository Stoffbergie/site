import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { runCli } from "../helpers/site";

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
