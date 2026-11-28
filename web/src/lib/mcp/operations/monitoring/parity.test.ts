import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assembleOperations } from "@/lib/mcp/operations";
import { MAX_PANELS } from "@/lib/views/explore/types";
import {
  ACTION_FILES,
  CHANGES,
  EXPLORE,
  EXPLORE_FILES,
  exportedFunctions,
  importedActions,
  MCP_ONLY,
  PARITY,
  parityProblems,
  takenChanges,
} from "./parity";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const operations = new Map(
  assembleOperations({ focusedConsole: true, customMonitoring: true, evals: true }).map(
    (operation) => [operation.id, operation],
  ),
);

test("each console action of these modules has an MCP operation", () => {
  assert.deepEqual(parityProblems(actions(), new Set(operations.keys())), []);
});

test("each operation without a console action exists, says why, and is no action's operation", () => {
  assert.deepEqual(Object.keys(MCP_ONLY).sort(), ["describe_rql_schema", "run_rql"]);
  const covering = new Set(Object.values(PARITY).filter((covered) => typeof covered === "string"));
  for (const [id, why] of Object.entries(MCP_ONLY)) {
    assert.ok(operations.has(id), `${id} is no operation`);
    assert.ok(why.length > 0, id);
    assert.ok(!covering.has(id), `${id} covers a console action: remove it from MCP_ONLY`);
  }
});

test("F452-1: the location settings are covered, and fail without their operation", () => {
  const saved = "app/(console)/project/[projectId]/settings/geo-actions.ts#saveGeoAttributesAction";
  assert.ok(actions().includes(saved));
  const without = new Set(operations.keys());
  without.delete("change_location_attributes");
  assert.deepEqual(
    parityProblems(actions(), without).filter((problem) => problem.startsWith(saved)),
    [`${saved} names change_location_attributes, which is no operation`],
  );
});

test("a dashboard widget on the Overview is covered, and fails without its mapping", () => {
  const added =
    "app/(console)/project/[projectId]/overview-actions.ts#addDashboardWidgetToOverview";
  assert.ok(actions().includes(added));
  const { [added]: _, ...without } = PARITY;
  assert.deepEqual(parityProblems(actions(), new Set(operations.keys()), without), [
    `${added} has no MCP operation`,
  ]);
  // The same two ids as the action, for the change and for the read.
  for (const id of ["change_overview_layout", "get_overview"]) {
    const schema = z.toJSONSchema(operations.get(id)?.params as z.ZodType, { io: "input" });
    const names = Object.keys(schema.properties ?? {});
    for (const name of ["dashboardId", "widgetId"])
      assert.ok(names.includes(name), `${id} ${name}`);
  }
});

test("F452-2: a reason in place of an operation names no operation", () => {
  for (const [action, covered] of Object.entries(PARITY))
    if (typeof covered === "object" && !covered.none.includes("Slack's consent"))
      for (const id of operations.keys()) assert.ok(!covered.none.includes(id), `${action}: ${id}`);
});

test("an action left without an operation fails", () => {
  const added = "lib/views/scorers/actions.ts#archiveScorer";
  assert.deepEqual(parityProblems([...actions(), added], new Set(operations.keys())), [
    `${added} has no MCP operation`,
  ]);
  const { "lib/views/alerts/actions.ts#changeAlert": _, ...without } = PARITY;
  assert.deepEqual(parityProblems(actions(), new Set(operations.keys()), without), [
    "lib/views/alerts/actions.ts#changeAlert has no MCP operation",
  ]);
  assert.deepEqual(parityProblems(["x#y"], new Set(), { "x#y": "gone" }), [
    "x#y names gone, which is no operation",
  ]);
});

test("each change an action takes is an action of its operation", () => {
  const files = moduleFiles().filter((file) => takenChanges(read(file)).length > 0);
  for (const file of files) {
    const covered = CHANGES[file];
    if (!covered) {
      const browserOnly = exportedFunctions(read(file)).every(
        (name) => typeof PARITY[`${file}#${name}`] === "object",
      );
      assert.ok(browserOnly, `${file} takes changes and has no entry in CHANGES`);
      continue;
    }
    assert.deepEqual(
      takenChanges(read(file)).filter((change) => !(change in covered.actions)),
      [],
      `${file}: changes without an action of ${covered.operation}`,
    );
    const schema = z.toJSONSchema(operations.get(covered.operation)?.params as z.ZodType, {
      io: "input",
    }) as unknown as { properties: { action: { enum: string[] } } };
    for (const action of Object.values(covered.actions)) {
      if (typeof action === "object") assert.ok(operations.has(action.operation));
      else assert.ok(schema.properties.action.enum.includes(action), `${file}: ${action}`);
    }
  }
});

test("each Explore action is an operation that takes the panel's query object", () => {
  const schemaOf = (id: string) =>
    z.toJSONSchema(operations.get(id)?.params as z.ZodType, { io: "input" }) as unknown as {
      properties: Record<string, { enum?: string[]; maxItems?: number }>;
    };
  for (const [what, { operation, change, as }] of Object.entries(EXPLORE)) {
    assert.ok(operations.has(operation), `${what}: ${operation}`);
    if (change) assert.ok(schemaOf(operation).properties.action.enum?.includes(change), what);
    if (as) assert.ok(schemaOf(operation).properties.as?.enum?.includes(as), what);
  }
  assert.equal(schemaOf("query_monitoring").properties.queries.maxItems, MAX_PANELS);
  // The page changes and reads nothing that is not in the list.
  const sources = EXPLORE_FILES.map(read);
  const dashboards = CHANGES["lib/views/dashboards/actions.ts"].actions;
  assert.deepEqual(
    [...new Set(sources.flatMap(takenChanges))].map((name) => dashboards[name]).sort(),
    Object.values(EXPLORE)
      .flatMap(({ operation, change }) =>
        operation === "change_dashboard" && change ? [change] : [],
      )
      .sort(),
  );
  assert.deepEqual([...new Set(sources.flatMap(importedActions))], ["previewWidgetAction"]);
  for (const file of readdirSync(join(SRC, "components/console/explore")))
    assert.ok(
      importedActions(read(`components/console/explore/${file}`)).length === 0,
      `${file}: an action of its own`,
    );
});

test("an exported action is found however it is written", () => {
  assert.deepEqual(
    exportedFunctions(
      "export function a() {}\nexport async function b() {}\nexport const c = async (x) => 1;\nexport const D = 4;\nfunction e() {}",
    ),
    ["a", "b", "c"],
  );
  assert.deepEqual(takenChanges('| { action: "one"; x: 1 }\n| { action: "two-b" }'), [
    "one",
    "two-b",
  ]);
});

function actions(): string[] {
  return Object.values(ACTION_FILES)
    .flat()
    .flatMap(expand)
    .flatMap((file) => exportedFunctions(read(file)).map((name) => `${file}#${name}`));
}

function moduleFiles(): string[] {
  const { console: _, ...modules } = ACTION_FILES;
  return Object.values(modules).flat().flatMap(expand);
}

/** The files of a pattern `dir/*suffix`. */
function expand(pattern: string): string[] {
  const dir = dirname(pattern);
  const suffix = basename(pattern).replace("*", "");
  const files = readdirSync(join(SRC, dir)).filter(
    (file) =>
      (pattern.includes("*") ? file.endsWith(suffix) : file === suffix) && !file.includes(".test."),
  );
  assert.ok(files.length > 0, `${pattern} matches no file`);
  return files.map((file) => `${dir}/${file}`);
}

function read(file: string): string {
  return readFileSync(join(SRC, file), "utf8");
}
