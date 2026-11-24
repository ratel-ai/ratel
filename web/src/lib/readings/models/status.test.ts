import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "@/config";
import { recordModelCall, trackModelCall } from "@/lib/platform/model-call";
import { ModelHttpError } from "./providers/http";
import { type ModelFailure, type ModelFailureStore, startModelStatus } from "./status";

const KEY = "sk-secret-value-1234567890";

function harness(env: Record<string, string>) {
  const lines: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
  const failed: ModelFailure[] = [];
  const succeeded: string[] = [];
  const store: ModelFailureStore = {
    failed: async (failure) => {
      failed.push(failure);
    },
    succeeded: async (feature) => {
      succeeded.push(feature);
    },
    list: async () => [],
  };
  let clock = Date.parse("2026-11-24T10:00:00Z");
  const stop = startModelStatus({
    config: resolveConfig({ env }),
    environment: "production",
    store,
    now: () => clock,
    log: (level, fields, message) => lines.push({ level, fields, message }),
  });
  return {
    lines,
    failed,
    succeeded,
    stop,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const settle = () => new Promise((done) => setImmediate(done));

test("at start it logs the setup of each kind, warning when a named vendor cannot run", () => {
  const h = harness({ MODEL_PROVIDER: "bedrok", OPENAI_API_KEY: KEY });
  h.stop();
  assert.deepEqual(
    h.lines.map((line) => line.level),
    ["warn", "info", "info"],
  );
  assert.match(h.lines[0].message, /MODEL_PROVIDER=bedrok is not a vendor/);
  for (const line of h.lines) assert.ok(!JSON.stringify(line).includes(KEY));
});

test("a failed call is logged in one sentence and kept for the console; a later success clears it", async () => {
  const h = harness({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: KEY });
  try {
    const meta = {
      provider: "openai",
      model: "gpt-6.2-sol",
      feature: "workflow_label",
      payer: "ratel" as const,
    };
    await assert.rejects(
      trackModelCall(meta, async () => {
        throw new ModelHttpError(401, `OpenAI answered 401: ${KEY}`);
      }),
    );
    await settle();
    const warning = h.lines.find((line) => line.level === "warn");
    assert.match(warning?.message ?? "", /OpenAI refused the key in OPENAI_API_KEY \(401\)/);
    assert.deepEqual(warning?.fields, {
      feature: "workflow_label",
      provider: "openai",
      model: "gpt-6.2-sol",
      status: 401,
    });
    assert.equal(h.failed.length, 1);
    assert.equal(h.failed[0].kind, "text");
    assert.equal(h.failed[0].status, 401);
    assert.ok(!JSON.stringify(h.lines).includes(KEY));
    assert.ok(!JSON.stringify(h.failed).includes(KEY));

    recordModelCall({ ...meta, outcome: "ok", durationMs: 1 });
    recordModelCall({ ...meta, outcome: "ok", durationMs: 1 });
    await settle();
    assert.deepEqual(h.succeeded, ["workflow_label"]);
  } finally {
    h.stop();
  }
});

test("the same failure is logged and written once a minute; the ones between are counted on the next write", async () => {
  const h = harness({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: KEY });
  try {
    const fail = () =>
      recordModelCall({
        provider: "openai",
        model: "gpt-6.2-sol",
        feature: "topics_names",
        payer: "ratel",
        outcome: "error",
        durationMs: 1,
        error: new ModelHttpError(429, "slow"),
      });
    fail();
    fail();
    fail();
    h.advance(61_000);
    fail();
    await settle();
    assert.equal(h.lines.filter((line) => line.level === "warn").length, 2);
    // Four failures, two writes: the second carries the two it held back, and itself.
    assert.deepEqual(
      h.failed.map((failure) => failure.count ?? 1),
      [1, 3],
    );
  } finally {
    h.stop();
  }
});

test("a different failure is written at once, and a call that works drops what was held back", async () => {
  const h = harness({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: KEY });
  try {
    const call = (outcome: "ok" | "error", status = 429) =>
      recordModelCall({
        provider: "openai",
        model: "gpt-6.2-sol",
        feature: "topics_names",
        payer: "ratel",
        outcome,
        durationMs: 1,
        ...(outcome === "error" ? { error: new ModelHttpError(status, "x") } : {}),
      });
    call("error");
    call("error", 401);
    call("error", 401);
    call("ok");
    call("error", 401);
    await settle();
    assert.deepEqual(
      h.failed.map((failure) => [failure.status, failure.count ?? 1]),
      [
        [429, 1],
        [401, 1],
        // The 401 held back came before the call that worked: it is not counted again.
        [401, 1],
      ],
    );
  } finally {
    h.stop();
  }
});

test("a decision feature's failure is a decision failure, and outcomes that are not calls are ignored", async () => {
  const h = harness({ DECISION_PROVIDER: "levanto", SAGE_API_KEY: KEY });
  try {
    recordModelCall({
      provider: "levanto",
      model: "levanto-sage-2",
      feature: "match_quality_judge",
      payer: "ratel",
      outcome: "error",
      durationMs: 1,
      error: Object.assign(new Error("x"), { status: 401 }),
    });
    recordModelCall({
      provider: "openai",
      model: "gpt-6.2-sol",
      feature: "workflow_label",
      payer: "ratel",
      outcome: "skipped_no_key",
      durationMs: 0,
    });
    await settle();
    assert.equal(h.failed.length, 1);
    assert.equal(h.failed[0].kind, "decision");
    assert.match(h.failed[0].message, /SAGE_API_KEY/);
  } finally {
    h.stop();
  }
});

test("the console's check is not a feature: its calls change no feature's status", async () => {
  const h = harness({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: KEY });
  try {
    for (const outcome of ["error", "ok"] as const)
      recordModelCall({
        provider: "openai",
        model: "gpt-6.2-sol",
        feature: "model_check",
        payer: "ratel",
        outcome,
        durationMs: 1,
        ...(outcome === "error" ? { error: new ModelHttpError(401, "no") } : {}),
      });
    await settle();
    assert.deepEqual([h.failed.length, h.succeeded.length], [0, 0]);
    assert.equal(h.lines.filter((line) => line.level === "warn").length, 0);
  } finally {
    h.stop();
  }
});

test("after stop nothing is heard", async () => {
  const h = harness({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: KEY });
  h.stop();
  recordModelCall({
    provider: "openai",
    model: "m",
    feature: "workflow_label",
    payer: "ratel",
    outcome: "error",
    durationMs: 1,
    error: new Error("x"),
  });
  await settle();
  assert.equal(h.failed.length, 0);
});
