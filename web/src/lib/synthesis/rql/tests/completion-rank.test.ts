import assert from "node:assert/strict";
import { test } from "node:test";
import { countRqlUsage } from "../compile";
import { RQL_FUNCTIONS, RQL_TABLES } from "../domain/catalog";
import { rankRqlCompletions, rqlCompletions, rqlEditorData } from "../domain/editor";
import { NO_USAGE, type RqlCompletionUsage, usageKey } from "../domain/usage";

/**
 * The order of the RQL field's list (decision `completion-ranking`): inside one kind, the names
 * that hold data in the project go up, then the names that saved queries use together with the
 * names already in the text, then the names the saved queries use. A project with no history
 * gets the fixed start order: the order of the catalog.
 */

const TRACES = RQL_TABLES.find((t) => t.name === "traces")?.columns.map((c) => c.name) ?? [];
const FUNCTIONS = RQL_FUNCTIONS.map((fn) => fn.name);

/** The ranked labels at `|`. */
function ranked(text: string, usage: RqlCompletionUsage, properties = rqlEditorData()) {
  const pos = text.indexOf("|");
  const plain = text.replace("|", "");
  const found = rqlCompletions(plain, pos, false, properties);
  assert.ok(found, text);
  return rankRqlCompletions(plain, found, usage).map((option) => option.label);
}

const usage = (over: Partial<RqlCompletionUsage>): RqlCompletionUsage => ({ ...NO_USAGE, ...over });

test("a project with no history gets the fixed start order: the catalog's", () => {
  assert.deepEqual(ranked("select count(*) from traces where |", NO_USAGE), [
    ...TRACES,
    ...FUNCTIONS,
  ]);
  assert.deepEqual(
    ranked("select count(*) from |", NO_USAGE),
    RQL_TABLES.map((t) => t.name),
  );
});

test("a column with no data in the project ranks below a column with data", () => {
  const withData = TRACES.filter((name) => name !== "trace_id" && name !== "started_at");
  const order = ranked(
    "select count(*) from traces where |",
    usage({ columnsWithData: { traces: withData } }),
  );
  assert.deepEqual(order.slice(0, TRACES.length), [...withData, "trace_id", "started_at"]);
  // The kinds keep their place: the functions follow the columns.
  assert.deepEqual(order.slice(TRACES.length), FUNCTIONS);
  // A table that was not read is no evidence: its columns keep the start order.
  assert.deepEqual(
    ranked("select count(*) from traces where |", usage({ columnsWithData: { events: [] } })),
    [...TRACES, ...FUNCTIONS],
  );
});

test("a name used in the saved widgets and alert rules ranks above an unused one", () => {
  const saved = countRqlUsage([
    "select sum(cost_usd) from traces",
    "select avg(cost_usd) from traces where has_error",
  ]);
  const order = ranked("select | from traces", usage(saved));
  // `*` and `distinct`, the columns, then the functions.
  const columns = order.slice(2, 2 + TRACES.length);
  assert.deepEqual(columns.slice(0, 2), ["cost_usd", "has_error"]);
  const functions = order.slice(2 + TRACES.length);
  assert.deepEqual(functions.slice(0, 2), ["sum", "avg"]);
  // `*` and `distinct` keep the head of the list.
  assert.deepEqual(order.slice(0, 2), ["*", "distinct"]);
  // Tables too.
  assert.equal(
    ranked("select count(*) from |", usage(countRqlUsage(["select count(*) from scores"])))[0],
    "scores",
  );
});

test("a name that saved queries use with a name already in the text ranks higher than without that name", () => {
  const saved = countRqlUsage([
    "select count(*) from traces where geo_country = 'it' and root_error is null",
    "select count(*) from traces where geo_country = 'fr' and root_error is null",
    "select count(*) from traces where duration_ms > 5",
    "select count(*) from traces where duration_ms > 9",
    "select count(*) from traces where duration_ms > 1",
  ]);
  const without = ranked("select count(*) from traces where |", usage(saved));
  assert.equal(without[0], "duration_ms");
  const withName = ranked(
    "select count(*) from traces where geo_country = 'it' and |",
    usage(saved),
  );
  assert.equal(withName[0], "root_error");
  assert.ok(withName.indexOf("root_error") < without.indexOf("root_error"));
});

test("data comes before use: a used column with no data ranks below one with data", () => {
  const saved = countRqlUsage(["select sum(cost_usd) from traces"]);
  const order = ranked(
    "select count(*) from traces where |",
    usage({ ...saved, columnsWithData: { traces: TRACES.filter((name) => name !== "cost_usd") } }),
  );
  assert.equal(order[TRACES.length - 1], "cost_usd");
});

test("inside properties[' the properties with data and the used ones go up; a detected one stays last and off", () => {
  const data = rqlEditorData({ indexed: ["organization", "plan", "region"], detected: ["tenant"] });
  const text = "select count(*) from traces where properties['|";
  assert.deepEqual(ranked(text, NO_USAGE, data), ["organization", "plan", "region", "tenant"]);
  const saved = countRqlUsage(["select count(*) from traces where properties['region'] = 'eu'"]);
  assert.deepEqual(
    ranked(text, usage({ ...saved, propertiesWithData: ["plan", "region"] }), data),
    ["region", "plan", "organization", "tenant"],
  );
});

test("the typed prefix still decides which items match: the score only orders them", () => {
  const saved = countRqlUsage(["select sum(cost_usd) from traces"]);
  const text = "select count(*) from traces where dur";
  const found = rqlCompletions(text, text.length, false);
  assert.ok(found);
  const order = rankRqlCompletions(text, found, usage(saved));
  assert.deepEqual(
    [...order.map((o) => o.label)].sort(),
    [...found.options.map((o) => o.label)].sort(),
  );
  // The word being typed is not a name of the text.
  assert.deepEqual(
    rankRqlCompletions(text, found, usage(countRqlUsage(["select dur from traces"]))).map(
      (o) => o.label,
    ),
    [...TRACES, ...FUNCTIONS],
  );
});

test("the counts of saved queries: one per query that names it, the pairs, bounded, and text that does not parse is skipped", () => {
  const counted = countRqlUsage([
    "select sum(cost_usd), sum(cost_usd) from traces",
    "select count(*) from traces where properties['plan'] = 'pro'",
    "this is not RQL",
  ]);
  assert.equal(counted.uses[usageKey("column", "cost_usd")], 1);
  assert.equal(counted.uses[usageKey("function", "sum")], 1);
  assert.equal(counted.uses[usageKey("table", "traces")], 2);
  assert.equal(counted.uses[usageKey("property", "plan")], 1);
  assert.equal(
    counted.together[
      [usageKey("column", "cost_usd"), usageKey("function", "sum")].sort().join("\n")
    ],
    1,
  );
  // Many names in one query: the pairs stay bounded.
  const wide = `select ${Array.from({ length: 80 }, (_, i) => `properties['p${i}']`).join(", ")} from traces`;
  const bounded = countRqlUsage(Array.from({ length: 50 }, () => wide));
  assert.ok(Object.keys(bounded.together).length <= 1_000);
  assert.ok(Object.keys(bounded.uses).length <= 33);
});
