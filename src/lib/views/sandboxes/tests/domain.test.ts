import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  gatewayChannel,
  parseRunNotifyPayload,
  runChannel,
  runNotifyPayload,
} from "../domain/channels";
import { normalizeEventBatch, refuseStart } from "../domain/run";

// Owned (ADR-0030): the module is lib/views/sandboxes here.
const DOMAIN_DIR = join(process.cwd(), "lib/views/sandboxes/domain");

test("channel names are plain identifiers, so LISTEN needs no quoting", () => {
  assert.equal(gatewayChannel("gw_a1"), "sandbox_gw_gw_a1");
  assert.equal(
    runChannel("0F8B7C2E-1D3A-4B5C-9D7E-1234567890AB"),
    "sandbox_run_0f8b7c2e1d3a4b5c9d7e1234567890ab",
  );
  assert.throws(() => gatewayChannel("gw-a; drop"), /invalid gateway id/);
  assert.throws(() => runChannel("not-a-uuid"), /invalid run id/);
});

test("a run notify carries the seq only, and a bad payload parses to null", () => {
  assert.equal(runNotifyPayload(7), '{"seq":7}');
  assert.equal(parseRunNotifyPayload('{"seq":7}'), 7);
  assert.equal(parseRunNotifyPayload("nope"), null);
  assert.equal(parseRunNotifyPayload(undefined), null);
});

test("refuseStart lets a run go only to a connected runner of its owner in its project", () => {
  const request = { projectId: "p1", ownerUserId: "u1" };
  assert.equal(refuseStart({ projectId: "p1", ownerUserId: "u1", gatewayId: "gw" }, request), null);
  assert.equal(
    refuseStart({ projectId: "p1", ownerUserId: "u2", gatewayId: "gw" }, request),
    "runner_not_owner",
  );
  assert.equal(
    refuseStart({ projectId: "p2", ownerUserId: "u1", gatewayId: "gw" }, request),
    "runner_not_found",
  );
  assert.equal(
    refuseStart({ projectId: "p1", ownerUserId: "u1", gatewayId: null }, request),
    "runner_offline",
  );
  assert.equal(refuseStart(null, request), "runner_not_found");
});

test("normalizeEventBatch orders by seq, keeps the first copy and rejects bad frames", () => {
  const batch = normalizeEventBatch([
    { seq: 2, kind: "log", payload: { n: "a" } },
    { seq: 1, kind: "text.delta", payload: {} },
    { seq: 2, kind: "log", payload: { n: "b" } },
  ]);
  assert.deepEqual(
    batch.map((e) => [e.seq, e.payload]),
    [
      [1, {}],
      [2, { n: "a" }],
    ],
  );
  assert.throws(() => normalizeEventBatch([{ seq: 0, kind: "log", payload: {} }]), /invalid seq/);
  assert.throws(
    () => normalizeEventBatch([{ seq: 1, kind: "run.start", payload: {} }]),
    /unknown event kind/,
  );
});

test("domain code does no I/O: it imports only the domain folder and node:crypto", () => {
  for (const file of readdirSync(DOMAIN_DIR)) {
    const source = readFileSync(join(DOMAIN_DIR, file), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith("./") || specifier === "node:crypto",
        `${file} imports ${specifier}`,
      );
    }
  }
});
