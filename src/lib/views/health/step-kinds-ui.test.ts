import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StepKindTables } from "@/components/console/health/StepKindTables";
import {
  type TypedStepFixtureName,
  typedStepFixtures,
} from "@/lib/ingest/otlp/__fixtures__/typed-steps";
import { deriveModelCalls } from "@/lib/ingest/otlp/derive-model-calls";
import { deriveSteps } from "@/lib/ingest/otlp/derive-steps";
import { deriveToolInvocations } from "@/lib/ingest/otlp/derive-tools";
import { buildTurns } from "@/lib/ledger/turns/build-turn";
import { normalizeEvents } from "@/lib/ledger/turns/normalize";
import type { TurnEventRow } from "@/lib/ledger/types";
import { stepReadingsOf } from "@/lib/readings/trace-signals/steps/metrics";
import { stepKindTables, stepPresets } from "@/lib/readings/trace-signals/steps/tables";
import type { StepsView } from "@/lib/readings/trace-signals/steps/view";

/** The fixture's spans through ingest and the turn build, as the signal run reads them. */
function turnsOf(name: TypedStepFixtureName) {
  const spans = typedStepFixtures()[name];
  const rows = [...deriveSteps(spans), ...deriveModelCalls(spans), ...deriveToolInvocations(spans)];
  const events = normalizeEvents(
    rows.map((row, i) => ({
      ...row,
      id: `${name}-${i}`,
      receivedAt: new Date(row.occurredAt.getTime() + 60_000),
      failed: row.errorMessage !== null,
    })) as TurnEventRow[],
    new Map(),
    { salt: "test" },
  );
  const now = new Date(Math.max(...spans.map((span) => span.endUnixMs)) + 24 * 60 * 60_000);
  return buildTurns({ stored: [], events, now }).turns.map((turn, i) => ({
    ...turn,
    id: `${name}-turn-${i}`,
  }));
}

function render(name: TypedStepFixtureName, view: StepsView = "all"): string {
  const readings = stepReadingsOf(turnsOf(name));
  return renderToStaticMarkup(
    createElement(StepKindTables, {
      tables: stepKindTables(readings, view, new Map()),
      view,
      presets: stepPresets("p1", 7),
    }),
  );
}

test("a model-only project renders the model call tables", () => {
  const html = render("stema");
  assert.match(html, /data-step-kind="model_call"/);
  assert.match(html, /Input tokens/);
  assert.match(html, /Code steps/);
  assert.doesNotMatch(html, /Tool calls/);
});

test("a flat chat with a tool call renders model and tool rows, and the presets filter them", () => {
  const all = render("cato");
  assert.match(all, /data-step-kind="model_call"/);
  assert.match(all, /data-step-kind="tool_call"/);
  const tools = render("cato", "tools");
  assert.doesNotMatch(tools, /data-step-kind="model_call"/);
  assert.match(tools, /data-step-kind="tool_call"/);
  assert.match(tools, /aria-current="true"[^>]*>Tools</);
});

test("the default view keeps engine names out", () => {
  for (const html of [render("stema"), render("cato")]) {
    assert.doesNotMatch(html, /otlp|model_call<|tool_call<|p95|snake_case/);
  }
});
