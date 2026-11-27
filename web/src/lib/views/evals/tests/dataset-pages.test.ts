import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DatasetDraft,
  datasetPageModel,
  datasetsPageModel,
  draftQuery,
  FREEZE_NOTE,
  filterDatasets,
  inputText,
} from "../dataset-pages";
import type { EvalCase } from "../domain/case";
import { DATASET_KINDS, type Dataset, datasetQuerySchema } from "../domain/dataset";
import type { EvalDefinition } from "../domain/eval";
import type { DatasetRow } from "../history-view";
import { content, evalContent, PROJECT_ID } from "./support";

const at = new Date(Date.UTC(2026, 10, 27, 10));
const P = PROJECT_ID;

function listRow(over: Partial<DatasetRow>): DatasetRow {
  return {
    datasetId: "d1",
    name: "Refund asks",
    description: "Asks for a refund",
    kind: "fixed",
    rows: 2,
    query: null,
    updatedAt: at.toISOString(),
    evals: [],
    ...over,
  };
}

function dataset(query: unknown): Dataset {
  return {
    id: "d1",
    projectId: P,
    name: "Refund asks",
    description: null,
    query: datasetQuerySchema.parse(query),
    createdBy: "u",
    createdAt: at,
    updatedAt: at,
  };
}

function row(id: string, over: Partial<EvalCase["versions"][number]>): EvalCase {
  return {
    id,
    projectId: P,
    datasetId: "d1",
    evalId: null,
    name: id,
    labels: [],
    createdAt: at,
    versions: [
      {
        ...content(),
        id: `${id}-v1`,
        caseId: id,
        number: 1,
        sourceTurnId: null,
        sourceOutput: null,
        updatedAt: at,
        ...over,
      },
    ],
  };
}

function evalOn(id: string, datasetId: string): EvalDefinition {
  return {
    id,
    projectId: P,
    name: id,
    taskId: null,
    createdAt: at,
    versions: [
      {
        ...evalContent(),
        datasetId,
        id: `${id}-v1`,
        evalId: id,
        number: 1,
        createdBy: "u",
        createdAt: at,
      },
    ],
  };
}

test("the list shows the kind, the cases or the query, and the evals that use each dataset", () => {
  const rows = datasetsPageModel(P, [
    listRow({ evals: [{ evalId: "e1", name: "Refunds" }] }),
    listRow({ datasetId: "d2", rows: 1 }),
    listRow({ datasetId: "d3", kind: "rql", rows: null, query: "select trace_id from traces" }),
    listRow({ datasetId: "d4", kind: "auto", rows: null, query: "Ratel chooses 50 traces" }),
  ]);
  assert.deepEqual(
    rows.map(({ kindLabel, cases }) => [kindLabel, cases]),
    [
      ["Fixed", "2 cases"],
      ["Fixed", "1 case"],
      ["RQL query", "select trace_id from traces"],
      ["Ratel chooses", "Ratel chooses 50 traces"],
    ],
  );
  assert.equal(rows[0]?.href, `/project/${P}/datasets/d1`);
  assert.deepEqual(rows[0]?.usedBy, [
    { evalId: "e1", name: "Refunds", href: `/project/${P}/evals/e1` },
  ]);
  assert.equal(rows[0]?.description, "Asks for a refund");
});

test("the filter matches the name, the description, the kind and the query", () => {
  const rows = datasetsPageModel(P, [
    listRow({}),
    listRow({
      datasetId: "d2",
      name: "Errors",
      description: null,
      kind: "rql",
      rows: null,
      query: "select trace_id from traces where has_error",
    }),
  ]);
  assert.deepEqual(filterDatasets(rows, "  ").length, 2);
  assert.deepEqual(
    filterDatasets(rows, "REFUND").map(({ datasetId }) => datasetId),
    ["d1"],
  );
  assert.deepEqual(
    filterDatasets(rows, "has_error").map(({ datasetId }) => datasetId),
    ["d2"],
  );
  assert.deepEqual(
    filterDatasets(rows, "rql").map(({ datasetId }) => datasetId),
    ["d2"],
  );
});

test("a fixed dataset shows its rows, with a trace link on each trace row", () => {
  const page = datasetPageModel({
    projectId: P,
    dataset: dataset({ kind: "fixed" }),
    rows: [
      row("r1", { input: { message: "refund A200" }, sourceTurnId: "t1", expectedOutput: "No." }),
      row("r2", { input: { order: "A1", amount: 3 } }),
    ],
    evals: [evalOn("e1", "d1"), evalOn("e2", "other")],
  });
  assert.equal(page.fixed, true);
  if (!page.fixed) return;
  assert.deepEqual(page.rows, [
    {
      rowId: "r1",
      name: "r1",
      kind: "trace",
      input: "refund A200",
      expectedOutput: "No.",
      turnHref: `/project/${P}/traces/turns/t1`,
    },
    {
      rowId: "r2",
      name: "r2",
      kind: "values",
      input: '{"order":"A1","amount":3}',
      expectedOutput: null,
      turnHref: null,
    },
  ]);
  assert.deepEqual(
    page.usedBy.map(({ evalId }) => evalId),
    ["e1"],
  );
});

test("a query dataset shows its query and says that a run freezes the rows", () => {
  const page = datasetPageModel({
    projectId: P,
    dataset: dataset({ kind: "task_traces", taskId: "wf-refunds", limit: 20 }),
    rows: [],
    evals: [],
  });
  assert.equal(page.fixed, false);
  if (page.fixed) return;
  assert.equal(page.kindLabel, "Traces of a task");
  assert.equal(page.query, "The last 20 traces of the task wf-refunds");
  assert.equal(page.freezeNote, FREEZE_NOTE);
  assert.match(page.freezeNote, /run freezes the rows/);
});

test("an input is one text when it holds one text, else its JSON", () => {
  assert.equal(inputText("hi"), "hi");
  assert.equal(inputText({ message: "hi" }), "hi");
  assert.equal(inputText({ a: 1 }), '{"a":1}');
  assert.equal(inputText(null), "null");
});

test("a draft gives the query of its kind, or says what is missing", () => {
  const draft = (over: Partial<DatasetDraft>): DatasetDraft => ({
    kind: "fixed",
    limit: "50",
    taskId: "",
    rql: "",
    ...over,
  });
  assert.deepEqual(draftQuery(draft({})), { ok: true, query: { kind: "fixed" } });
  assert.deepEqual(draftQuery(draft({ kind: "last_traces", limit: " 20 " })), {
    ok: true,
    query: { kind: "last_traces", limit: 20 },
  });
  for (const limit of ["0", "501", "2.5", "x", ""]) {
    assert.equal(draftQuery(draft({ kind: "last_traces", limit })).ok, false, limit);
  }
  assert.deepEqual(draftQuery(draft({ kind: "task_traces" })), {
    ok: false,
    message: "Choose the task.",
  });
  assert.deepEqual(draftQuery(draft({ kind: "task_traces", taskId: "wf-1" })), {
    ok: true,
    query: { kind: "task_traces", taskId: "wf-1", limit: 50 },
  });
  assert.deepEqual(draftQuery(draft({ kind: "rql", rql: "  " })), {
    ok: false,
    message: "Write the query.",
  });
  assert.deepEqual(draftQuery(draft({ kind: "rql", rql: "select trace_id from traces" })), {
    ok: true,
    query: { kind: "rql", text: "select trace_id from traces", limit: 50 },
  });
  assert.deepEqual(draftQuery(draft({ kind: "auto" })), {
    ok: true,
    query: { kind: "auto", taskId: null, limit: 50 },
  });
  // Each query the dialog sends, the server takes.
  for (const kind of DATASET_KINDS) {
    const made = draftQuery(draft({ kind, taskId: "wf-1", rql: "select trace_id from traces" }));
    assert.ok(made.ok);
    if (made.ok) assert.deepEqual(datasetQuerySchema.parse(made.query), made.query);
  }
});
