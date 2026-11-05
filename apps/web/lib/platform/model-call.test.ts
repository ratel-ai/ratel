import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicUsage, recordModelCall, setModelCallSink, trackModelCall } from "./model-call";

const META = { provider: "anthropic", model: "claude-haiku-5-5", feature: "eval_gate_judge" };

function capture() {
  const lines: { fields: Record<string, unknown>; message: string }[] = [];
  const restore = setModelCallSink({
    info: (fields, message) => lines.push({ fields, message }),
    warn: () => {},
  });
  return { lines, restore };
}

test("with no sink a tracked call only runs: its answer and its error pass through", async () => {
  assert.equal(await trackModelCall(META, async () => 7), 7);
  await assert.rejects(
    trackModelCall(META, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.doesNotThrow(() => recordModelCall({ ...META, outcome: "skipped_no_key", durationMs: 0 }));
});

test("a sink gets one model_call line per call, with tokens, duration and outcome", async () => {
  const { lines, restore } = capture();
  try {
    let clock = 1000;
    const result = await trackModelCall(
      { ...META, projectId: "p1", organizationId: "o1" },
      async () => ({ usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6 } }),
      anthropicUsage,
      () => {
        clock += 250;
        return clock;
      },
    );
    assert.equal(result.usage.output_tokens, 4);
    assert.deepEqual(lines, [
      {
        message: "model_call",
        fields: {
          provider: "anthropic",
          model: "claude-haiku-5-5",
          feature: "eval_gate_judge",
          organization_id: "o1",
          project_id: "p1",
          input_tokens: 16,
          output_tokens: 4,
          cached_tokens: 6,
          cache_write_tokens: 0,
          duration_ms: 250,
          outcome: "ok",
        },
      },
    ]);
  } finally {
    restore();
  }
});

test("a failed call is a line with the error's class and no tokens; a refusal carries its count", async () => {
  const { lines, restore } = capture();
  try {
    await assert.rejects(
      trackModelCall(META, async () => {
        throw new TypeError("nope");
      }),
    );
    recordModelCall({ ...META, outcome: "refused_budget", durationMs: 0, calls: 3 });
    assert.deepEqual(
      lines.map(({ fields }) => [
        fields.outcome,
        fields.error_type,
        fields.calls,
        fields.input_tokens,
      ]),
      [
        ["error", "TypeError", undefined, null],
        ["refused_budget", undefined, 3, null],
      ],
    );
  } finally {
    restore();
  }
});

test("a sink that throws never breaks the call it describes", async () => {
  const restore = setModelCallSink({
    info: () => {
      throw new Error("sink down");
    },
    warn: () => {},
  });
  try {
    assert.equal(await trackModelCall(META, async () => "ok"), "ok");
  } finally {
    restore();
  }
});

test("Anthropic usage counts cache reads and writes into the input", () => {
  assert.deepEqual(anthropicUsage({}), {});
  assert.deepEqual(
    anthropicUsage({
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 1,
      },
    }),
    { inputTokens: 9, outputTokens: 2, cachedTokens: 3, cacheWriteTokens: 1 },
  );
});
