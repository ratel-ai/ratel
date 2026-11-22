import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadValidator, MAX_FRAME_BYTES } from "../src/protocol";

/**
 * The gateway's validator against the sandbox/v1 conformance fixtures, copied from
 * the ratel repo (`protocol/sandbox/v1/conformance`, commit 7a6765ef).
 */

const FIXTURES = join(process.cwd(), "test/fixtures");
const validator = loadValidator();

function fixtures(dir: string): [string, unknown, string][] {
  return readdirSync(join(FIXTURES, dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = readFileSync(join(FIXTURES, dir, f), "utf8");
      return [f, JSON.parse(raw), raw];
    });
}

test("every valid message fixture passes and fits in a frame", () => {
  const valid = fixtures("valid/messages");
  assert.ok(valid.length >= validator.knownTypes.size);
  for (const [name, frame, raw] of valid) {
    assert.equal(validator.message(frame), null, name);
    assert.ok(Buffer.byteLength(raw) <= MAX_FRAME_BYTES, name);
  }
});

test("every valid manifest fixture passes", () => {
  for (const [name, manifest] of fixtures("valid/manifest"))
    assert.equal(validator.manifest(manifest), null, name);
});

test("every invalid message fixture fails, by schema or by frame size", () => {
  for (const [name, frame, raw] of fixtures("invalid/messages")) {
    const failsSize = Buffer.byteLength(raw) > MAX_FRAME_BYTES;
    assert.ok(failsSize || validator.message(frame) !== null, name);
  }
});

test("every invalid manifest fixture fails", () => {
  for (const [name, manifest] of fixtures("invalid/manifest"))
    assert.notEqual(validator.manifest(manifest), null, name);
});
