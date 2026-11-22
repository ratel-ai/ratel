import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { resetConfigForTests } from "@/config";
import { composition } from "@/lib/composition";
import type { ModelCallLogContext, ModelCallRecord } from "@/lib/contracts/telemetry";
import { ModelNotEnabledError } from "@/lib/platform/anthropic-errors";
import { runWithLogContext } from "@/lib/platform/logger";
import {
  anthropicUsage,
  recordModelCall,
  recordTracedModelCall,
  setModelCallExceptionReporter,
  setModelCallSink,
  trackModelCall,
} from "./model-call";
import { withProjectLogContext } from "./project-log-context";

const META = {
  provider: "anthropic",
  model: "claude-haiku-5-5",
  feature: "eval_gate_judge",
  payer: "ratel" as const,
};

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
          payer: "ratel",
          organization_id: "o1",
          project_id: "p1",
          input_tokens: 16,
          output_tokens: 4,
          cached_tokens: 6,
          cache_write_tokens: 0,
          duration_ms: 250,
          outcome: "ok",
          backend: "api",
        },
      },
    ]);
  } finally {
    restore();
  }
});

test("on Bedrock, a Claude line says backend bedrock and keeps provider anthropic; other providers say api", async () => {
  const saved = process.env.ANTHROPIC_BACKEND;
  process.env.ANTHROPIC_BACKEND = "bedrock";
  resetConfigForTests();
  const { lines, restore } = capture();
  try {
    await trackModelCall(META, async () => 1);
    recordModelCall({
      ...META,
      provider: "openai",
      model: "gpt-6-luna",
      outcome: "ok",
      durationMs: 5,
    });
    recordModelCall({ ...META, outcome: "skipped_no_key", durationMs: 0 });
    assert.deepEqual(
      lines.map(({ fields }) => [fields.provider, fields.backend, fields.outcome]),
      [
        ["anthropic", "bedrock", "ok"],
        ["openai", "api", "ok"],
        ["anthropic", "bedrock", "skipped_no_key"],
      ],
    );
  } finally {
    restore();
    if (saved === undefined) delete process.env.ANTHROPIC_BACKEND;
    else process.env.ANTHROPIC_BACKEND = saved;
    resetConfigForTests();
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

test("withProjectLogContext names the project and its organization for the work inside", async () => {
  const { lines, restore } = capture();
  try {
    const result = await withProjectLogContext(
      "project-9",
      async () => {
        recordModelCall({ ...META, outcome: "ok", durationMs: 1 });
        return "done";
      },
      async () => ({ org_id: "org-9", org_slug: "acme", project_path: "acme/default" }),
    );

    assert.equal(result, "done");
    assert.equal(lines[0]?.fields.organization_id, "org-9");
    assert.equal(lines[0]?.fields.project_id, "project-9");
  } finally {
    restore();
  }
});

test("withProjectLogContext still runs the work when the organization can't be found", async () => {
  const { lines, restore } = capture();
  try {
    await withProjectLogContext(
      "project-9",
      async () => recordModelCall({ ...META, outcome: "ok", durationMs: 1 }),
      async () => {
        throw new Error("db down");
      },
    );
    assert.equal(lines[0]?.fields.project_id, "project-9");
    assert.equal(lines[0]?.fields.organization_id, null);
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

/** Bedrock's 403 for a model with no Marketplace agreement, as the client turns it. */
function notEnabled(model = "claude-sonnet-4-6"): ModelNotEnabledError {
  const denied = new Anthropic.PermissionDeniedError(
    403,
    { message: "AWS Marketplace actions" },
    "403 AWS Marketplace actions",
    new Headers(),
  );
  return new ModelNotEnabledError(model, `eu.anthropic.${model}`, denied);
}

async function onBedrock(run: () => Promise<void>): Promise<void> {
  const saved = process.env.ANTHROPIC_BACKEND;
  process.env.ANTHROPIC_BACKEND = "bedrock";
  resetConfigForTests();
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_BACKEND;
    else process.env.ANTHROPIC_BACKEND = saved;
    resetConfigForTests();
  }
}

test("a model not enabled on Bedrock logs error_type model_not_enabled with the model, never a class name", async () => {
  const { lines, restore } = capture();
  const restoreReporter = setModelCallExceptionReporter(() => {});
  try {
    await onBedrock(async () => {
      await assert.rejects(
        trackModelCall(
          { ...META, model: "claude-sonnet-4-6", feature: "eval_gate_replay" },
          async () => {
            throw notEnabled();
          },
        ),
        ModelNotEnabledError,
      );
    });
  } finally {
    restoreReporter();
    restore();
  }
  const [line] = lines;
  assert.equal(line?.fields.outcome, "error");
  assert.equal(line?.fields.error_type, "model_not_enabled");
  assert.equal(line?.fields.model, "claude-sonnet-4-6");
  assert.equal(line?.fields.backend, "bedrock");
});

test("a model not enabled on Bedrock is reported once as an exception with feature, model, profile and backend", async () => {
  const reported: { error: unknown; distinctId: string; properties: Record<string, unknown> }[] =
    [];
  const restoreReporter = setModelCallExceptionReporter((error, distinctId, properties) =>
    reported.push({ error, distinctId, properties }),
  );
  const thrown = notEnabled();
  try {
    await onBedrock(async () => {
      await assert.rejects(
        trackModelCall(
          {
            ...META,
            model: "claude-sonnet-4-6",
            feature: "eval_gate_replay",
            projectId: "project-1",
          },
          async () => {
            throw thrown;
          },
        ),
      );
      await assert.rejects(
        trackModelCall(META, async () => {
          throw new Error("throttled");
        }),
      );
    });
  } finally {
    restoreReporter();
  }
  assert.equal(reported.length, 1, "only the not-enabled failure is reported");
  assert.equal(reported[0]?.error, thrown);
  assert.equal(reported[0]?.distinctId, "project:project-1");
  assert.deepEqual(reported[0]?.properties, {
    operation: "model_call",
    feature: "eval_gate_replay",
    model: "claude-sonnet-4-6",
    bedrock_profile: "eu.anthropic.claude-sonnet-4-6",
    backend: "bedrock",
    project_id: "project-1",
  });
});

test("an exception reporter failure never breaks the call", async () => {
  const thrown = notEnabled();
  const restoreReporter = setModelCallExceptionReporter(() => {
    throw new Error("reporter down");
  });
  try {
    await assert.rejects(
      trackModelCall(META, async () => {
        throw thrown;
      }),
      (err) => err === thrown,
    );
  } finally {
    restoreReporter();
  }
});

/** The edition's recorder on the telemetry port, for one block of work. */
async function withRecorder(
  recorder: NonNullable<typeof composition.telemetry.recordModelCall>,
  work: () => Promise<void> | void,
): Promise<void> {
  const previous = composition.telemetry.recordModelCall;
  composition.telemetry.recordModelCall = recorder;
  try {
    await work();
  } finally {
    composition.telemetry.recordModelCall = previous;
  }
}

test("an edition's recorder gets the raw record and the log context of every call, made or not", async () => {
  const seen: { record: ModelCallRecord; context: ModelCallLogContext }[] = [];
  await withRecorder(
    (record, context) => seen.push({ record, context }),
    async () => {
      await runWithLogContext(
        { project_id: "p1", org_id: "o1", org_slug: "acme", project_path: "acme/app" },
        async () => {
          await trackModelCall(
            META,
            async () => ({ usage: { input_tokens: 10, output_tokens: 4 } }),
            anthropicUsage,
          );
          await assert.rejects(
            trackModelCall(META, async () => {
              throw new TypeError("boom");
            }),
          );
          recordModelCall({ ...META, outcome: "refused_budget", durationMs: 0, calls: 3 });
          recordModelCall({ ...META, outcome: "skipped_no_key", durationMs: 0 });
          recordTracedModelCall({ ...META, outcome: "ok", durationMs: 12, inputTokens: 5 }, 0);
        },
      );
    },
  );

  assert.deepEqual(
    seen.map(({ record }) => [record.outcome, record.inputTokens ?? null, record.calls ?? null]),
    [
      ["ok", 10, null],
      ["error", null, null],
      ["refused_budget", null, 3],
      ["skipped_no_key", null, null],
      ["ok", 5, null],
    ],
  );
  assert.ok(seen[1]?.record.error instanceof TypeError, "the error itself, for its class only");
  for (const { record, context } of seen) {
    assert.deepEqual(
      [record.provider, record.model, record.feature, record.payer],
      [META.provider, META.model, META.feature, META.payer],
    );
    assert.deepEqual(context, {
      project_id: "p1",
      org_id: "o1",
      org_slug: "acme",
      project_path: "acme/app",
    });
  }
});

test("with an edition's recorder the sink is not written: the edition owns the line", async () => {
  const { lines, restore } = capture();
  try {
    let recorded = 0;
    await withRecorder(
      () => {
        recorded += 1;
      },
      () => recordModelCall({ ...META, outcome: "ok", durationMs: 1 }),
    );
    assert.equal(recorded, 1);
    assert.equal(lines.length, 0);
  } finally {
    restore();
  }
});

test("a recorder that throws never breaks the call it describes", async () => {
  await withRecorder(
    () => {
      throw new Error("recorder down");
    },
    async () => {
      assert.equal(await trackModelCall(META, async () => 7), 7);
      assert.doesNotThrow(() => recordModelCall({ ...META, outcome: "ok", durationMs: 1 }));
    },
  );
});
