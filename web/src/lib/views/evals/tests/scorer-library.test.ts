import assert from "node:assert/strict";
import { test } from "node:test";
import type { Scorer } from "@/lib/views/scorers/types";
import type { EvalDefinition, EvalScorer } from "../domain/eval";
import { PREDEFINED_SCORERS } from "../domain/predefined-scorers";
import type { ScorerLibrary } from "../ports/scorer-library";
import { listScorerLibrary, resolveScorers } from "../scorer-library";
import { evalContent, NO_REFUND, PROJECT_ID } from "./support";

const CHECK_ID = "c0000000-0000-4000-8000-000000000001";
const TRACE_ID = "c0000000-0000-4000-8000-000000000002";
const PRESET_ID = "c0000000-0000-4000-8000-000000000003";
const NUMERIC_ID = "c0000000-0000-4000-8000-000000000004";

function projectScorer(id: string, name: string, definition: { kind: string; config: object }) {
  return {
    id,
    projectId: PROJECT_ID,
    name,
    ...definition,
    filter: {} as Scorer["filter"],
    tasks: null,
    sampleRate: 100,
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as Scorer;
}

const library: ScorerLibrary = {
  projectScorers: async () => [
    projectScorer(CHECK_ID, "Short answer", {
      kind: "check",
      config: { path: "output_tokens", op: "lte", value: 200 },
    }),
    projectScorer(TRACE_ID, "Prod only", {
      kind: "check",
      config: { path: "attributes.env", op: "eq", value: "prod" },
    }),
    projectScorer(PRESET_ID, "Finishes", { kind: "preset", config: { preset: "ends_well" } }),
    projectScorer(NUMERIC_ID, "Tone 1-5", {
      kind: "judge",
      config: { prompt: "Rate the tone", output: "numeric" },
    }),
  ],
};

function inlineEval(name: string): EvalDefinition {
  return {
    id: "e1",
    projectId: PROJECT_ID,
    name,
    taskId: null,
    createdAt: new Date(0),
    versions: [
      {
        ...evalContent(),
        datasetId: "d1",
        id: "v1",
        evalId: "e1",
        number: 1,
        createdBy: "u",
        createdAt: new Date(0),
      },
    ],
  };
}

test("the library lists the project's scorers, the pre-defined set and the scorers from an eval", async () => {
  const entries = await listScorerLibrary(PROJECT_ID, {
    library,
    evals: { list: async () => [inlineEval("Refunds")] },
  });
  const project = entries.filter(({ source }) => source === "project");
  assert.deepEqual(
    project.map(({ name, usable }) => [name, usable]),
    [
      ["Short answer", true],
      ["Prod only", false],
      ["Finishes", false],
      ["Tone 1-5", false],
    ],
  );
  assert.match(project[1]?.why ?? "", /trial/);
  assert.match(project[2]?.why ?? "", /pre-defined/);
  assert.match(project[3]?.why ?? "", /yes or no/);
  assert.equal(
    entries.filter(({ source }) => source === "predefined").length,
    PREDEFINED_SCORERS.length,
  );
  const fromEval = entries.filter(({ source }) => source === "eval");
  assert.deepEqual(
    fromEval.map(({ name, evalName }) => [name, evalName]),
    [[NO_REFUND.name, "Refunds"]],
  );
});

test("a run resolves each reference again: the project scorer as it is now, the pre-defined one with its settings", async () => {
  const scorers: EvalScorer[] = [
    NO_REFUND,
    {
      id: "short",
      name: "Short answer",
      gating: true,
      definition: { kind: "check", config: { path: "output_tokens", op: "lte", value: 999 } },
      ref: { source: "project", scorerId: CHECK_ID },
    },
    {
      id: "tool",
      name: "Tool was called",
      gating: false,
      definition: { kind: "check", config: { path: "tools", op: "contains", value: "old" } },
      ref: { source: "predefined", key: "expected_tool", settings: { tool: "lookup_order" } },
    },
  ];
  const resolved = await resolveScorers(PROJECT_ID, scorers, library);
  assert.ok(resolved.ok);
  assert.deepEqual(resolved.scorers[0], NO_REFUND);
  assert.deepEqual(resolved.scorers[1]?.definition, {
    kind: "check",
    config: { path: "output_tokens", op: "lte", value: 200 },
  });
  assert.deepEqual(resolved.scorers[2]?.definition, {
    kind: "check",
    config: { path: "tools", op: "contains", value: "lookup_order" },
  });
});

test("a reference to a missing or unusable scorer refuses the run with the reason", async () => {
  const gone = await resolveScorers(
    PROJECT_ID,
    [
      {
        ...NO_REFUND,
        ref: { source: "project", scorerId: "c0000000-0000-4000-8000-00000000000f" },
      },
    ],
    library,
  );
  assert.equal(gone.ok, false);
  assert.match(gone.ok ? "" : gone.message, /No refund.*not in the library/);
  const preset = await resolveScorers(
    PROJECT_ID,
    [{ ...NO_REFUND, ref: { source: "project", scorerId: PRESET_ID } }],
    library,
  );
  assert.match(preset.ok ? "" : preset.message, /pre-defined/);
});
