import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { setModelCallSink, setModelCallTracer } from "@/lib/platform/model-call";
import type { AnthropicClient } from "@/lib/readings/anthropic/client";
import { anthropicFakeModel } from "../adapters/anthropic-fake-model";
import { createFakeAlerts } from "../adapters/fake-alerts";
import type { GenerationInput } from "../domain/generation";

/**
 * The generator adapter (structured output, tracked as Ratel's spend) and the cap alert.
 * Owned (ADR-0030): the model-call seam here has no project label lookup to switch off.
 */

let lines: { fields: Record<string, unknown>; message: string }[] = [];
const restores: (() => void)[] = [];

beforeEach(() => {
  lines = [];
  restores.push(
    setModelCallSink({
      info: (fields, message) => lines.push({ fields, message }),
      warn: () => {},
    }),
  );
  restores.push(setModelCallTracer(null));
});

afterEach(() => {
  while (restores.length) restores.pop()!();
});

const INPUT: GenerationInput = {
  request: {
    runId: "r",
    callId: "c",
    tool: "createTicket",
    description: "Open a support ticket",
    args: { title: "Search is down" },
  },
  examples: [],
  ledger: { tickets: [] },
  messages: [{ role: "user", text: "open a ticket" }],
};

function clientAnswering(text: string, sent: unknown[] = []): AnthropicClient {
  return {
    messages: {
      create: (async (params: unknown) => {
        sent.push(params);
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text }],
          usage: { input_tokens: 120, output_tokens: 30 },
        };
      }) as unknown as AnthropicClient["messages"]["create"],
      stream: (() => {
        throw new Error("not used");
      }) as unknown as AnthropicClient["messages"]["stream"],
    },
  };
}

test("the generator asks the small model for structured output and logs the call as Ratel's spend", async () => {
  const sent: Record<string, unknown>[] = [];
  const model = anthropicFakeModel(
    clientAnswering(
      '{"result_json":"{\\"id\\":\\"T-1\\"}","state_json":"{\\"tickets\\":[\\"T-1\\"]}","is_error":false}',
      sent,
    ),
  );
  const out = await model.generate(INPUT, { projectId: "p-1", organizationId: "o-1" });
  assert.deepEqual(out, { result: { id: "T-1" }, state: { tickets: ["T-1"] }, isError: false });

  assert.equal(sent[0]!.model, "claude-haiku-5-5");
  assert.equal((sent[0]!.output_config as { format: { type: string } }).format.type, "json_schema");
  const line = lines.find((l) => l.message === "model_call")!;
  assert.equal(line.fields.payer, "ratel");
  assert.equal(line.fields.feature, "sandbox_fake");
  assert.equal(line.fields.project_id, "p-1");
  assert.equal(line.fields.outcome, "ok");
  assert.equal(line.fields.input_tokens, 120);
});

test("a refused or malformed answer throws, so the service answers a tool error", async () => {
  await assert.rejects(
    anthropicFakeModel(clientAnswering("not json")).generate(INPUT, {
      projectId: "p",
      organizationId: null,
    }),
  );
});

test("the cap alert logs one error line with the event name and captures one server event", () => {
  const logged: { fields: Record<string, unknown>; message: string }[] = [];
  const captured: unknown[] = [];
  const alerts = createFakeAlerts(
    { error: (fields, message) => logged.push({ fields, message }) },
    (id, event, props) => captured.push([id, event, props]),
  );
  alerts.capReached({ projectId: "p-1", organizationId: "o-1", day: "2026-11-20", runId: "r-1" });
  assert.deepEqual(logged, [
    {
      fields: {
        event: "sandbox_fake_cap_reached",
        project_id: "p-1",
        organization_id: "o-1",
        day: "2026-11-20",
        run_id: "r-1",
      },
      message: "sandbox fake cap reached",
    },
  ]);
  assert.deepEqual(captured, [
    [
      "project:p-1",
      "sandbox_fake_cap_reached",
      { project_id: "p-1", org_id: "o-1", day: "2026-11-20" },
    ],
  ]);
});
