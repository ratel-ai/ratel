import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  anthropicUsage,
  setModelCallSink,
  setModelCallTracer,
  trackModelCall,
} from "@/lib/platform/model-call";
import { MODEL_CALL_TRACER } from "@/lib/platform/otel/ratel-export";
import { jobAskSpec } from "./job-ask";
import { inProjectLogContext } from "./project-context";

/**
 * The ask a backend job's agent run exports to Ratel's own project (ratel-cloud #517, RC-834):
 * the `invoke_agent` root span, captured as the exporter receives it. Owned: upstream pins
 * `jobAsk` alone in `handlers-agent-run.test.ts`; here the whole run is exercised.
 */

const PROJECT_ID = "6f1e2d3c-4b5a-4968-8776-655443322110";
const CUSTOMER_TEXT = "please fix the refund flow for Jane Doe";
const USER_ID = "user_2abcDEFghiJKL";
const ANSWER = {
  content: [{ type: "text" as const, text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
};
const DRAFT_FIX_ASK = jobAskSpec<{ fixId: string; requestedBy: string }>("Draft a fix", {
  fixId: true,
  requestedBy: false,
});
const noLabels = async () => null;

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
const restores: Array<() => void> = [];

beforeEach(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  restores.push(
    setModelCallTracer(provider.getTracer(MODEL_CALL_TRACER)),
    setModelCallSink({ info: () => {}, warn: () => {} }),
  );
});

afterEach(async () => {
  while (restores.length) restores.pop()!();
  context.disable();
  await provider.shutdown();
});

test("a run ask with a project id, a user id and customer text sends none of them", async () => {
  const handler = inProjectLogContext(
    DRAFT_FIX_ASK,
    () =>
      trackModelCall(
        { provider: "anthropic", model: "claude-haiku-4-5", feature: "fix_draft", payer: "ratel" },
        async () => ANSWER,
        anthropicUsage,
      ),
    noLabels,
  );

  await handler({
    id: "job-1",
    projectId: PROJECT_ID,
    kind: "draft_fix",
    payload: { fixId: "fix-9", requestedBy: USER_ID, note: CUSTOMER_TEXT, projectId: PROJECT_ID },
  });

  const root = exporter
    .getFinishedSpans()
    .find((span) => span.attributes["gen_ai.operation.name"] === "invoke_agent");
  assert.ok(root, "an invoke_agent root");
  const sent = JSON.stringify({ name: root.name, attributes: root.attributes });
  if (process.env.RATEL_CAPTURE_ASK) writeFileSync(process.env.RATEL_CAPTURE_ASK, `${sent}\n`);

  assert.deepEqual(JSON.parse(String(root.attributes["gen_ai.input.messages"])), [
    { role: "user", parts: [{ type: "text", content: "Draft a fix (fixId fix-9)" }] },
  ]);
  assert.equal(root.attributes["gen_ai.agent.name"], "draft_fix");
  for (const secret of [PROJECT_ID, CUSTOMER_TEXT, "Jane Doe", USER_ID]) {
    assert.ok(!sent.includes(secret), `${secret} must not reach the exported run`);
  }
});
