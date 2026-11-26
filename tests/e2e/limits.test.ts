import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { test } from "vite-plus/test";
import { apiKeyOf, baseUrl, newHome, upload } from "../helpers/site";

const BULK_ATTEMPTS = 11;

function compactUpload(files: object[]): Buffer {
  const compressedIndex = brotliCompressSync(Buffer.from(JSON.stringify({ spa: false, files })));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(compressedIndex.byteLength);
  return Buffer.concat([Buffer.from("SITEPACK2\n"), length, compressedIndex]);
}

async function deployCount(key: string): Promise<number> {
  const listed = await fetch(`${baseUrl}/list`, { headers: { authorization: `Bearer ${key}` } });
  return ((await listed.json()) as { deploys: unknown[] }).deploys.length;
}

test("deploys that store over 10 MB, index included, from one IPv6 /64 are limited, whatever address in it they come from", { timeout: 120_000 }, async () => {
  const key = await apiKeyOf(newHome());
  const networkGroup = randomBytes(2).toString("hex");
  const network = `2001:db8:0:${networkGroup}`;
  const source = await upload("/big.bin", randomBytes(2_000_000), { authorization: `Bearer ${key}`, "cf-connecting-ip": `${network}::1` });
  assert.equal(source.status, 201, source.text);
  const sourceId = new URL(source.text.trim()).hostname.split(".")[0];
  const tenMegabytesOfFiles = compactUpload(Array.from({ length: 5 }, (_, number) => ({ path: `copy-${number}.bin`, length: 2_000_000, reuse: { id: sourceId, file: 0 } })));
  assert.ok(tenMegabytesOfFiles.byteLength < 1000);

  let refused = null;
  let stored = 0;
  for (let attempt = 1; attempt <= BULK_ATTEMPTS && refused === null; attempt += 1) {
    const address = `2001:db8::${networkGroup}:0:${attempt.toString(16)}:${randomBytes(2).toString("hex")}:1`;
    const reply = await upload("/", tenMegabytesOfFiles, { authorization: `Bearer ${key}`, "cf-connecting-ip": address }, "POST");
    if (reply.status === 429) refused = reply;
    else {
      assert.equal(reply.status, 201, reply.text);
      stored += 1;
    }
  }
  assert.ok(refused, `${BULK_ATTEMPTS} deploys of 10 MB of files from one /64 were all stored`);
  assert.equal(refused.headers["retry-after"], "60");
  assert.match(refused.text, /Too many requests/);
  assert.equal(await deployCount(key), stored + 1);

  const expanded = network
    .split(":")
    .map((group) => group.padStart(4, "0"))
    .join(":");
  const sameNetworkLongForm = await upload("/", tenMegabytesOfFiles, { authorization: `Bearer ${key}`, "cf-connecting-ip": `${expanded}:0000:0000:0000:0002` }, "POST");
  assert.equal(sameNetworkLongForm.status, 429, sameNetworkLongForm.text);

  const small = await upload("/page.html", "<h1>small</h1>", { authorization: `Bearer ${key}`, "cf-connecting-ip": `${network}::3` });
  assert.equal(small.status, 201, small.text);

  const otherNetwork = await upload("/", tenMegabytesOfFiles, { authorization: `Bearer ${key}`, "cf-connecting-ip": `2001:db8:ffff:${randomBytes(2).toString("hex")}::1` }, "POST");
  assert.equal(otherNetwork.status, 201, otherNetwork.text);
});
