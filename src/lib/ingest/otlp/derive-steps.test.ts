import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { typedStepFixtures } from "@/lib/ingest/otlp/__fixtures__/typed-steps";
import { agentHealthToolRows } from "@/lib/ingest/otlp/agent-health-bridge";
import { deriveAgentRuns } from "@/lib/ingest/otlp/derive-agent-runs";
import { deriveModelCalls } from "@/lib/ingest/otlp/derive-model-calls";
import { deriveSteps } from "@/lib/ingest/otlp/derive-steps";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";

test("production shapes produce code and nested agent handoffs", () => {
  const fixtures = typedStepFixtures();
  const expected = {
    ratel: [],
    bareChat: [],
    stema: ["code"],
    vibiz: ["code", "code", "handoff", "code"],
    cato: [],
    docs: ["code", "code", "code"],
  };
  for (const [name, spans] of Object.entries(fixtures)) {
    assert.deepEqual(
      deriveSteps(spans).map((row) => row.payload.kind),
      expected[name as keyof typeof expected],
      name,
    );
  }
  const handoff = deriveSteps(fixtures.vibiz).find((row) => row.payload.kind === "handoff");
  assert.ok(handoff);
  assert.equal(handoff.payload.name, "researcher");
  assert.equal(handoff.payload.parent_agent, "growth_agent");
  assert.equal(handoff.sessionId, "fixture-growth-conversation");
});

test("infrastructure, SDK, client and short spans are not code steps", () => {
  const span = typedStepFixtures().docs[0];
  const extras: Partial<DecodedSpan>[] = [
    { name: "POST" },
    { name: "ratel.experiment.arm" },
    { attributes: { "http.request.method": "POST" } },
    { attributes: { "db.system.name": "postgresql" } },
    { scopeName: "@ratel-ai/sdk" },
    { kind: 3 },
    { endUnixMs: span.startUnixMs + 4 },
  ];
  for (const extra of extras) assert.deepEqual(deriveSteps([{ ...span, ...extra }]), []);
});

test("model rows store hashes, counts, reasoning and a stable signature", () => {
  const fixtures = typedStepFixtures();
  const rows = deriveModelCalls(fixtures.docs);
  assert.deepEqual(
    rows.map((row) => row.payload.user_message_count),
    [1, 2],
  );
  assert.equal(
    rows[0].payload.user_message_hash,
    createHash("sha256").update("Summarize the sample document.").digest("hex"),
  );
  const model = {
    ...fixtures.ratel[1],
    attributes: {
      ...fixtures.ratel[1].attributes,
      "ratel.step.name": "classify",
      "gen_ai.usage.reasoning_tokens": 12,
    },
  };
  const [row] = deriveModelCalls([model]);
  assert.equal(row.payload.signature_token, "classify");
  assert.equal(row.payload.reasoning_tokens, 12);
  assert.equal(deriveModelCalls(fixtures.ratel)[0].payload.signature_token, "fixture-model-client");
  assert.equal(deriveModelCalls(fixtures.bareChat)[0].payload.signature_token, "claude-sonnet-5-5");
});

test("the bridge adds typed step rows without message text and workflow roots with their ask", async () => {
  const spans = typedStepFixtures().docs;
  // Owned: the bridge here takes no organization, and the turn kick has no flag gate.
  const bridged = await agentHealthToolRows(spans, "project", {
    traceTurns: {
      enqueueBuild: async () => null,
      scheduleProjectDrain: () => {},
    },
    logError: () => {},
  });
  assert.equal(bridged.filter((row) => row.type === "otlp_step").length, 3);
  assert.equal(
    bridged
      .filter((row) => row.type === "otlp_step")
      .some((row) => JSON.stringify(row).includes("Summarize")),
    false,
  );
  assert.equal(
    JSON.stringify(bridged).includes("Summarize"),
    true,
    "model rows keep the captured ask",
  );
  const root = typedStepFixtures().ratel[0];
  const workflow = {
    ...root,
    attributes: {
      ...root.attributes,
      "gen_ai.operation.name": "invoke_workflow",
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "private sample" }]),
    },
  };
  const rows = deriveAgentRuns([workflow]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.prompt, "private sample");
});

test("model and agent rows keep the captured ask and the system mark", () => {
  const docs = typedStepFixtures().docs;
  const asks = (rows: ReturnType<typeof deriveModelCalls>) =>
    rows.map(({ payload }) => ({ prompt: payload.prompt, started_by: payload.started_by }));
  assert.equal(
    asks(deriveModelCalls(docs)).every((row) => typeof row.prompt === "string"),
    true,
  );
  for (const [text, startedBy] of [
    ["Summarize the sample document.", undefined],
    ["<task-notification> sample finished", "system"],
  ] as const) {
    const root = {
      ...docs[0],
      attributes: {
        ...docs[0].attributes,
        "gen_ai.operation.name": "invoke_agent",
        "ai.prompt.messages": JSON.stringify([{ role: "user", content: text }]),
      },
    };
    assert.equal(deriveAgentRuns([root])[0].payload.prompt, text);
    const chat = {
      ...docs[2],
      attributes: {
        ...docs[2].attributes,
        "ai.prompt.messages": JSON.stringify([{ role: "user", content: text }]),
      },
    };
    assert.deepEqual(asks(deriveModelCalls([chat])), [{ prompt: text, started_by: startedBy }]);
  }
});
