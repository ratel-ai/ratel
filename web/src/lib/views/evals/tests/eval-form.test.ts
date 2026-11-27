import assert from "node:assert/strict";
import { test } from "node:test";
import type { ParamSpec } from "@/lib/views/sandboxes/run-form";
import {
  checkEvalDraft,
  checkRunDraft,
  type EvalDraft,
  emptyEvalDraft,
  type FormContext,
  libraryKey,
  matrixOf,
  PRODUCTION_SOON,
  type RunDefaults,
  runDraftOf,
  runtimeParams,
  scorerGroups,
} from "../eval-form";
import type { LibraryEntry } from "../scorer-library";

const MODEL: ParamSpec = {
  name: "model",
  type: "enum",
  default: "sonnet",
  description: null,
  options: ["sonnet", "haiku", "opus"],
};
const TONE: ParamSpec = { name: "tone", type: "string", default: "friendly", description: null, options: [] };
const TEMP: ParamSpec = { name: "temperature", type: "number", default: 0, description: null, options: [] };
const V2 = "22222222-2222-4222-8222-222222222222";
const V1 = "11111111-1111-4111-8111-111111111111";

const PREDEFINED: LibraryEntry = {
  source: "predefined",
  id: "output_contains",
  name: "Output contains",
  description: "The output has the text (any case).",
  kind: "check",
  usable: true,
  why: null,
  settings: [{ name: "value", type: "string", description: "The text to look for." }],
  evalName: null,
};
const JUDGE: LibraryEntry = {
  ...PREDEFINED,
  id: "is_safe",
  name: "Answer is safe",
  description: "A judge checks the output.",
  kind: "judge",
  settings: [],
};
const PROJECT_SCORER: LibraryEntry = {
  source: "project",
  id: "33333333-3333-4333-8333-333333333333",
  name: "Says refund",
  description: null,
  kind: "check",
  usable: true,
  why: null,
  settings: [],
  evalName: null,
};
const PRESET: LibraryEntry = {
  ...PROJECT_SCORER,
  id: "44444444-4444-4444-8444-444444444444",
  name: "Task preset",
  kind: "preset",
  usable: false,
  why: "a task preset reads the runs of a task, not one trial.",
};

const CTX: FormContext = {
  sandboxes: [
    {
      name: "support-demo",
      versions: [
        { id: V2, label: "v2", params: [MODEL, TONE, TEMP] },
        { id: V1, label: "v1", params: [TONE] },
      ],
    },
  ],
  library: [PROJECT_SCORER, PRESET, PREDEFINED, JUDGE],
};

function draft(over: Partial<EvalDraft> = {}): EvalDraft {
  return {
    ...emptyEvalDraft(CTX, null),
    name: "Refunds",
    scorers: [{ key: libraryKey(PROJECT_SCORER), gating: true, settings: {} }],
    ...over,
  };
}

test("a new eval starts on the first sandbox at its newest ready version, with a query dataset", () => {
  const empty = emptyEvalDraft(CTX, null);
  assert.deepEqual(empty.runtime, { kind: "sandbox", sandboxName: "support-demo", version: "latest" });
  assert.deepEqual(empty.dataset, { kind: "last_traces", limit: "50" });
  assert.deepEqual(emptyEvalDraft(CTX, "d1").dataset, { kind: "existing", datasetId: "d1" });
  assert.deepEqual(emptyEvalDraft({ ...CTX, sandboxes: [] }, null).runtime, { kind: "production" });
  // The params are those of the chosen version.
  assert.deepEqual(
    runtimeParams(CTX, { kind: "sandbox", sandboxName: "support-demo", version: V1 }).map(
      ({ name }) => name,
    ),
    ["tone"],
  );
  assert.deepEqual(runtimeParams(CTX, { kind: "production" }), []);
});

test("an eval is made with each runtime and each dataset choice", () => {
  const latest = checkEvalDraft(draft(), CTX);
  assert.ok(latest.ok);
  assert.equal(latest.body.sandboxName, "support-demo");
  assert.equal(latest.body.sandboxVersionId, null);
  assert.deepEqual(latest.body.dataset, { query: { kind: "last_traces", limit: 50 } });
  assert.deepEqual(latest.body.scorers, [
    {
      id: "scorer-33333333",
      name: "Says refund",
      gating: true,
      ref: { source: "project", scorerId: PROJECT_SCORER.id },
    },
  ]);
  const pinned = checkEvalDraft(
    draft({ runtime: { kind: "sandbox", sandboxName: "support-demo", version: V1 } }),
    CTX,
  );
  assert.ok(pinned.ok && pinned.body.sandboxVersionId === V1);

  const datasets = [
    [{ kind: "existing", datasetId: "d1" }, { datasetId: "d1" }],
    [
      { kind: "task_traces", taskId: " task-1 ", limit: "20" },
      { query: { kind: "task_traces", taskId: "task-1", limit: 20 } },
    ],
    [
      { kind: "rql", text: "SELECT trace_id FROM traces", limit: "30" },
      { query: { kind: "rql", text: "SELECT trace_id FROM traces", limit: 30 } },
    ],
    [{ kind: "auto", taskId: "", limit: "10" }, { query: { kind: "auto", taskId: null, limit: 10 } }],
  ] as const;
  for (const [dataset, body] of datasets) {
    const made = checkEvalDraft(draft({ dataset }), CTX);
    assert.ok(made.ok, dataset.kind);
    assert.deepEqual(made.body.dataset, body);
  }
});

test("each field refuses with its reason", () => {
  const refused = checkEvalDraft(
    draft({
      name: " ",
      dataset: { kind: "rql", text: " ", limit: "501" },
      trials: "0",
      scorers: [],
    }),
    CTX,
  );
  assert.ok(!refused.ok);
  assert.deepEqual(Object.keys(refused.errors).sort(), ["limit", "name", "scorers", "trials"]);
  const noTask = checkEvalDraft(draft({ dataset: { kind: "task_traces", taskId: "", limit: "5" } }), CTX);
  assert.equal(noTask.ok ? null : noTask.errors.dataset, "Choose a task.");
  const noText = checkEvalDraft(draft({ dataset: { kind: "rql", text: "", limit: "5" } }), CTX);
  assert.match(noText.ok ? "" : (noText.errors.dataset ?? ""), /trace_id column/);
  const noDataset = checkEvalDraft(draft({ dataset: { kind: "existing", datasetId: "" } }), CTX);
  assert.equal(noDataset.ok ? null : noDataset.errors.dataset, "Choose a dataset.");
  const badParam = checkEvalDraft(draft({ params: { temperature: "hot" } }), CTX);
  assert.equal(badParam.ok ? null : badParam.errors["params.temperature"], "temperature must be a number.");
});

test("Production agent is refused as coming soon, and no sandbox says to push one", () => {
  const production = checkEvalDraft(draft({ runtime: { kind: "production" } }), CTX);
  assert.equal(production.ok ? null : production.errors.runtime, PRODUCTION_SOON);
  const none = checkEvalDraft(
    draft({ runtime: { kind: "sandbox", sandboxName: "gone", version: "latest" } }),
    { ...CTX, sandboxes: [] },
  );
  assert.match(none.ok ? "" : (none.errors.runtime ?? ""), /Push one first/);
  const oldVersion = checkEvalDraft(
    draft({ runtime: { kind: "sandbox", sandboxName: "support-demo", version: "nope" } }),
    CTX,
  );
  assert.match(oldVersion.ok ? "" : (oldVersion.errors.runtime ?? ""), /ready version/);
});

test("a matrix is typed by the declared params, counts its combinations and stops at 12", () => {
  const made = matrixOf([MODEL, TONE, TEMP], { model: "sonnet, haiku", tone: "formal,friendly,formal" });
  assert.deepEqual(made, {
    ok: true,
    matrix: { model: ["sonnet", "haiku"], tone: ["formal", "friendly"] },
    count: 4,
  });
  const over = matrixOf([MODEL, TONE, TEMP], {
    model: "sonnet, haiku, opus",
    tone: "a, b",
    temperature: "0, 0.5, 1",
  });
  assert.equal(over.count, 18);
  assert.equal(
    over.ok ? null : over.errors.matrix,
    "A matrix has at most 12 combinations, and this one has 18. Remove values.",
  );
  const wrong = matrixOf([MODEL], { model: "sonnet, gpt" });
  assert.match(wrong.ok ? "" : (wrong.errors["matrix.model"] ?? ""), /one of: sonnet, haiku, opus/);
  const one = matrixOf([MODEL], { model: "sonnet" });
  assert.match(one.ok ? "" : (one.errors.matrix ?? ""), /at least two combinations/);

  const eval12 = checkEvalDraft(
    draft({
      matrixOn: true,
      params: { model: "opus", tone: "calm" },
      matrix: { model: "sonnet, haiku, opus", tone: "a, b, c, d" },
    }),
    CTX,
  );
  assert.ok(eval12.ok);
  // A param of the matrix takes its values there, not from the defaults.
  assert.deepEqual(eval12.body.params, {});
  assert.deepEqual(Object.keys(eval12.body.matrix), ["model", "tone"]);
  const eval13 = checkEvalDraft(
    draft({ matrixOn: true, matrix: { model: "sonnet, haiku, opus", tone: "a, b, c, d, e" } }),
    CTX,
  );
  assert.match(eval13.ok ? "" : (eval13.errors.matrix ?? ""), /at most 12 combinations, and this one has 15/);
});

test("scorers come from the library: settings, an unusable scorer, at least one gating", () => {
  const settings = checkEvalDraft(
    draft({ scorers: [{ key: libraryKey(PREDEFINED), gating: true, settings: {} }] }),
    CTX,
  );
  assert.match(settings.ok ? "" : (settings.errors["scorer.predefined:output_contains.value"] ?? ""), /needs this/);
  const twice = checkEvalDraft(
    draft({
      scorers: [
        { key: libraryKey(PREDEFINED), gating: true, settings: { value: "refund" } },
        { key: libraryKey(PREDEFINED), gating: false, settings: { value: "sorry" } },
        { key: libraryKey(JUDGE), gating: false, settings: {} },
      ],
    }),
    CTX,
  );
  assert.ok(twice.ok);
  assert.deepEqual(
    twice.body.scorers.map(({ id, name, ref }) => [id, name, ref]),
    [
      [
        "output_contains",
        "Output contains: refund",
        { source: "predefined", key: "output_contains", settings: { value: "refund" } },
      ],
      [
        "output_contains-2",
        "Output contains: sorry",
        { source: "predefined", key: "output_contains", settings: { value: "sorry" } },
      ],
      ["is_safe", "Answer is safe", { source: "predefined", key: "is_safe", settings: {} }],
    ],
  );
  const unusable = checkEvalDraft(
    draft({ scorers: [{ key: libraryKey(PRESET), gating: true, settings: {} }] }),
    CTX,
  );
  assert.match(unusable.ok ? "" : (unusable.errors.scorers ?? ""), /cannot score a trial/);
  const noGate = checkEvalDraft(
    draft({ scorers: [{ key: libraryKey(JUDGE), gating: false, settings: {} }] }),
    CTX,
  );
  assert.match(noGate.ok ? "" : (noGate.errors.scorers ?? ""), /decide the result/);
});

test("the scorer picker groups the project's scorers and the pre-defined set, with search", () => {
  assert.deepEqual(
    scorerGroups(CTX.library, "").map(({ label, entries }) => [label, entries.length]),
    [
      ["This project", 2],
      ["Pre-defined", 2],
    ],
  );
  assert.deepEqual(
    scorerGroups(CTX.library, "JUDGE").map(({ entries }) => entries.map(({ name }) => name)),
    [[], ["Answer is safe"]],
  );
});

// — New run ———————————————————————————————————————————————————————————————————

const DEFAULTS: RunDefaults = {
  datasetId: "d1",
  sandboxName: "support-demo",
  versionId: null,
  params: { model: "sonnet" },
  matrix: {},
  trials: 3,
  scorers: [{ key: libraryKey(PROJECT_SCORER), gating: true, settings: {} }],
};

test("a run at the defaults changes nothing", () => {
  const made = checkRunDraft(runDraftOf(DEFAULTS), DEFAULTS, CTX);
  assert.deepEqual(made, { ok: true, body: {} });
});

test("a run sends only what it changes, for itself only", () => {
  const made = checkRunDraft(
    {
      ...runDraftOf(DEFAULTS),
      name: " Haiku try ",
      datasetId: "d2",
      addRows: { kind: "turns", turnIds: ["t1", "t1", "t2"] },
      version: V1,
      params: { model: "sonnet", tone: "formal" },
      trials: "1",
      scorersChanged: true,
      scorers: [{ key: libraryKey(JUDGE), gating: true, settings: {} }],
    },
    DEFAULTS,
    CTX,
  );
  assert.ok(made.ok);
  assert.deepEqual(made.body, {
    name: "Haiku try",
    dataset: "d2",
    rows: { kind: "turns", turnIds: ["t1", "t2"] },
    sandboxVersion: V1,
    params: { tone: "formal" },
    trials: 1,
    scorers: [
      { id: "is_safe", name: "Answer is safe", gating: true, ref: { source: "predefined", key: "is_safe", settings: {} } },
    ],
  });
});

test("a run can add a matrix, or turn off the matrix of the eval, within 12 combinations", () => {
  const withMatrix = checkRunDraft(
    { ...runDraftOf(DEFAULTS), matrixOn: true, matrix: { model: "sonnet, haiku" } },
    DEFAULTS,
    CTX,
  );
  assert.deepEqual(withMatrix.ok && withMatrix.body, { matrix: { model: ["sonnet", "haiku"] } });
  const matrixEval = { ...DEFAULTS, matrix: { model: ["sonnet", "haiku"] } };
  assert.equal(runDraftOf(matrixEval).matrix.model, "sonnet, haiku");
  const off = checkRunDraft({ ...runDraftOf(matrixEval), matrixOn: false }, matrixEval, CTX);
  assert.deepEqual(off.ok && off.body, { matrix: {} });
  const over = checkRunDraft(
    {
      ...runDraftOf(DEFAULTS),
      matrixOn: true,
      matrix: { model: "sonnet, haiku, opus", temperature: "0, 1, 2, 3, 4" },
    },
    DEFAULTS,
    CTX,
  );
  assert.match(over.ok ? "" : (over.errors.matrix ?? ""), /at most 12 combinations/);
});

test("added rows: the last N traces, Ratel's choice, a pick that is empty or too long", () => {
  const last = checkRunDraft(
    { ...runDraftOf(DEFAULTS), addRows: { kind: "last_traces", limit: "10" } },
    DEFAULTS,
    CTX,
  );
  assert.deepEqual(last.ok && last.body, { rows: { kind: "last_traces", limit: 10 } });
  const auto = checkRunDraft({ ...runDraftOf(DEFAULTS), addRows: { kind: "auto", limit: "x" } }, DEFAULTS, CTX);
  assert.ok(!auto.ok && auto.errors.limit);
  const none = checkRunDraft({ ...runDraftOf(DEFAULTS), addRows: { kind: "turns", turnIds: [] } }, DEFAULTS, CTX);
  assert.equal(none.ok ? null : none.errors.rows, "Choose at least one trace.");
  const many = checkRunDraft(
    {
      ...runDraftOf(DEFAULTS),
      addRows: { kind: "turns", turnIds: Array.from({ length: 101 }, (_, i) => `t${i}`) },
    },
    DEFAULTS,
    CTX,
  );
  assert.match(many.ok ? "" : (many.errors.rows ?? ""), /at most 100/);
});

test("a pinned eval runs its pinned version unless the run asks for the newest", () => {
  const pinned = { ...DEFAULTS, versionId: V1, params: {} };
  assert.deepEqual(checkRunDraft(runDraftOf(pinned), pinned, CTX), { ok: true, body: {} });
  const newest = checkRunDraft({ ...runDraftOf(pinned), version: "latest" }, pinned, CTX);
  assert.deepEqual(newest.ok && newest.body, { sandboxVersion: "latest" });
});
