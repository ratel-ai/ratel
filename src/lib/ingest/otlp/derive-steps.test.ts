import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { typedStepFixtures } from "./__fixtures__/typed-steps";
import baseline from "./__fixtures__/typed-steps-main.json";
import { agentHealthToolRows } from "./agent-health-bridge";
import { deriveAgentRuns } from "./derive-agent-runs";
import { deriveModelCalls } from "./derive-model-calls";
import { deriveSteps } from "./derive-steps";
import { deriveToolInvocations } from "./derive-tools";
import type { DecodedSpan } from "./types";

test("the disabled derivations preserve the main fixture output byte for byte", () => {
  for (const [name, spans] of Object.entries(typedStepFixtures())) {
    assert.equal(
      JSON.stringify({
        tools: deriveToolInvocations(spans),
        models: deriveModelCalls(spans),
        agents: deriveAgentRuns(spans),
      }),
      JSON.stringify(baseline[name as keyof typeof baseline]),
      name,
    );
  }
});

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

test("typed model rows store hashes, counts, reasoning and a stable signature without message text", () => {
  const fixtures = typedStepFixtures();
  const rows = deriveModelCalls(fixtures.docs, { typedSteps: true });
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
  const [row] = deriveModelCalls([model], { typedSteps: true });
  assert.equal(row.payload.signature_token, "classify");
  assert.equal(row.payload.reasoning_tokens, 12);
  assert.equal(
    deriveModelCalls(fixtures.ratel, { typedSteps: true })[0].payload.signature_token,
    "fixture-model-client",
  );
  assert.equal(
    deriveModelCalls(fixtures.bareChat, { typedSteps: true })[0].payload.signature_token,
    "claude-sonnet-5-5",
  );
});

test("the bridge gates new rows and workflow roots with one flag", async () => {
  const spans = typedStepFixtures().docs;
  for (const enabled of [false, true]) {
    // Owned: the bridge here takes no organization, and the turn kick has no flag gate.
    const rows = await agentHealthToolRows(spans, "project", {
      traceTurns: {
        enqueueBuild: async () => null,
        scheduleProjectDrain: () => {},
      },
      agentRunsEnabled: async () => false,
      typedStepsEnabled: async () => enabled,
      logError: () => {},
    });
    assert.equal(rows.filter((row) => row.type === "otlp_step").length, enabled ? 3 : 0);
    assert.equal(JSON.stringify(rows).includes("Summarize"), true);
  }
  const root = typedStepFixtures().ratel[0];
  const workflow = {
    ...root,
    attributes: {
      ...root.attributes,
      "gen_ai.operation.name": "invoke_workflow",
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "private sample" }]),
    },
  };
  assert.equal(deriveAgentRuns([workflow]).length, 0);
  const rows = deriveAgentRuns([workflow], { typedSteps: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.prompt, "private sample");
});

test("typed model and agent rows keep the captured ask and the system mark as main writes them", () => {
  const docs = typedStepFixtures().docs;
  const asks = (rows: ReturnType<typeof deriveModelCalls>) =>
    rows.map(({ payload }) => ({ prompt: payload.prompt, started_by: payload.started_by }));
  const on = asks(deriveModelCalls(docs, { typedSteps: true }));
  assert.deepEqual(on, asks(deriveModelCalls(docs)));
  assert.equal(
    on.every((row) => typeof row.prompt === "string"),
    true,
  );
  for (const text of ["Summarize the sample document.", "<task-notification> sample finished"]) {
    const root = {
      ...docs[0],
      attributes: {
        ...docs[0].attributes,
        "gen_ai.operation.name": "invoke_agent",
        "ai.prompt.messages": JSON.stringify([{ role: "user", content: text }]),
      },
    };
    const off = asks(deriveAgentRuns([root]));
    assert.equal(off[0].prompt, text);
    assert.deepEqual(asks(deriveAgentRuns([root], { typedSteps: true })), off);
    const chat = {
      ...docs[2],
      attributes: {
        ...docs[2].attributes,
        "ai.prompt.messages": JSON.stringify([{ role: "user", content: text }]),
      },
    };
    assert.deepEqual(
      asks(deriveModelCalls([chat], { typedSteps: true })),
      asks(deriveModelCalls([chat])),
    );
  }
  const system = {
    ...docs[2],
    attributes: {
      ...docs[2].attributes,
      "ai.prompt.messages": JSON.stringify([
        { role: "user", content: "<task-notification> sample finished" },
      ]),
    },
  };
  assert.equal(deriveModelCalls([system], { typedSteps: true })[0].payload.started_by, "system");
});
