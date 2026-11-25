import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { checkBundle } from "../domain/bundle-check";
import { bundleInfo, pax, type TarEntry, tarGz } from "./support";

async function* chunks(body: Buffer, size = 7) {
  for (let i = 0; i < body.length; i += size) yield body.subarray(i, i + size);
}
const check = (body: Buffer, info = bundleInfo(body)) => checkBundle(chunks(body), info);

test("files and folders inside the project pass", async () => {
  const long = `src/${"deep/".repeat(40)}agent.ts`;
  const bundle = tarGz([
    { name: "src/", type: "5" },
    { name: "src/agent.ts", body: "export default 1;".repeat(100) },
    { name: "a..b/..c.ts", body: "x" },
    pax(long),
    { name: "cut", body: "y" },
    { name: "empty.txt" },
  ]);
  assert.deepEqual(await check(bundle), { ok: true });
});

const refused: Array<[string, TarEntry[], RegExp]> = [
  ["a ../ entry", [{ name: "../evil.sh", body: "x" }], /"\.\.\/evil\.sh" leaves the project/],
  ["a nested ../ entry", [{ name: "ok/../../evil.sh" }], /leaves the project/],
  ["an absolute entry", [{ name: "/etc/passwd" }], /leaves the project/],
  ["a ../ entry in a pax header", [pax("../evil.sh"), { name: "safe" }], /leaves the project/],
  [
    "a ../ entry in a GNU long name",
    [{ name: "x", type: "L", body: "../evil.sh\0" }, { name: "safe" }],
    /leaves the project/,
  ],
  ["a symbolic link", [{ name: "link", type: "2", link: "/etc" }], /not a file or a folder/],
  ["a hard link", [{ name: "link", type: "1", link: "x" }], /not a file or a folder/],
  ["a device", [{ name: "dev", type: "3" }], /not a file or a folder/],
  ["no file", [], /no files/],
];
for (const [label, entries, message] of refused) {
  test(`${label} is refused`, async () => {
    const result = await check(
      tarGz(
        [{ name: "first.ts", body: "x" }]
          .slice(label === "no file" ? 1 : 0)
          .concat(entries as never),
      ),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, message);
  });
}

test("a pax size is refused: it hides entries from this check", async () => {
  const bundle = tarGz([{ name: "p", type: "x", body: "12 size=999\n" }, { name: "a" }]);
  assert.equal((await check(bundle)).ok, false);
});

test("a body that is not the announced bundle is refused", async () => {
  const bundle = tarGz([{ name: "a", body: "x" }]);
  const info = bundleInfo(bundle);
  for (const wrong of [
    { ...info, bytes: info.bytes + 1 },
    { ...info, sha256: "0".repeat(64) },
  ]) {
    const result = await check(bundle, wrong);
    assert.deepEqual(result.ok, false);
  }
});

test("text, a cut gzip and a cut tar are refused", async () => {
  const bundle = tarGz([{ name: "a", body: "x".repeat(2000) }]);
  const cutTar = gzipSync(Buffer.alloc(700, 1));
  for (const body of [Buffer.from("text"), bundle.subarray(0, bundle.length - 12), cutTar]) {
    assert.equal((await check(body)).ok, false);
  }
});

const END = Buffer.alloc(1024);
const FILE = gunzipSync(tarGz([{ name: "a.ts", body: "x" }])).subarray(0, 1024);

test("the bundle ends at its end marker", async () => {
  const padded = gzipSync(Buffer.concat([FILE, END, Buffer.alloc(8192)]));
  assert.deepEqual(await check(padded), { ok: true });
  const more = gzipSync(Buffer.concat([FILE, END, FILE]));
  assert.match(refusalOf(await check(more)), /after its end/);
  const huge = gzipSync(Buffer.concat([FILE, END, Buffer.alloc(2 * 1024 * 1024)]));
  assert.match(refusalOf(await check(huge)), /after its end/);
});

test("a refused bundle closes its source", async () => {
  const bad = tarGz([{ name: "../evil.sh", body: randomBytes(400_000).toString("hex") }]);
  const body = Readable.from(chunks(bad, 4096));
  assert.match(refusalOf(await checkBundle(body, bundleInfo(bad))), /leaves the project/);
  await new Promise((done) => setImmediate(done));
  assert.equal(body.destroyed, true);
});

test("a source that breaks is not a refusal of the bundle", async () => {
  const bundle = tarGz([{ name: "a.ts", body: "x" }]);
  async function* broken() {
    yield bundle.subarray(0, 20);
    throw new Error("connection lost");
  }
  await assert.rejects(checkBundle(broken(), bundleInfo(bundle)), /connection lost/);
});

function refusalOf(result: Awaited<ReturnType<typeof checkBundle>>): string {
  return result.ok ? "passed" : result.message;
}
