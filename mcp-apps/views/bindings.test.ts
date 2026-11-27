import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detailArgs,
  getPath,
  parseDetailConfig,
  parseListConfig,
  parseSeriesConfig,
} from "../shell/config";
import type { ViewFixture, ViewFixtures } from "../shell/types";
import detailView from "./detail/bindings";
import detailFixtures from "./detail/fixtures";
import listView from "./list/bindings";
import listFixtures from "./list/fixtures";
import seriesView from "./series/bindings";
import seriesFixtures from "./series/fixtures";

/**
 * The binding-load check: every bound tool has harness fixtures (its normal,
 * dense and empty results), and its binding reads them. A binding that names a
 * path the tool's data does not have fails here, not as a blank column in Claude.
 * Fixture data mirrors each tool's structuredContent (harness/data.ts).
 */

type Row = Record<string, unknown>;

function scenarios(fixtures: ViewFixtures, tool: string) {
  const pick = (name: string): ViewFixture => {
    const fixture = fixtures[name];
    assert.ok(fixture, `${tool}: the harness needs a fixture named "${name}"`);
    assert.equal(fixture.tool, tool, `fixture "${name}" renders ${tool}`);
    const body = fixture.result?.structuredContent as { ok?: boolean } | undefined;
    assert.equal(body?.ok, true, `fixture "${name}" is a success`);
    return fixture;
  };
  return { normal: pick(tool), dense: pick(`${tool} · dense`), empty: pick(`${tool} · empty`) };
}

function dataOf(fixture: ViewFixture): unknown {
  assert.ok(fixture.result, "the fixture has a tool result");
  return (fixture.result.structuredContent as { data: unknown }).data;
}

function rowsOf(fixture: ViewFixture, path: string, tool: string): Row[] {
  const rows = getPath(dataOf(fixture), path);
  assert.ok(Array.isArray(rows), `${tool}: data.${path} is the rows array`);
  return rows as Row[];
}

/** A key some row carries; a column nobody fills is a wrong path. */
function assertFilled(rows: Row[], key: string, where: string) {
  assert.ok(
    rows.some((row) => getPath(row, key) !== undefined),
    `${where}: no row has "${key}"`,
  );
}

for (const binding of listView.bindings) {
  test(`list: ${binding.tool} reads its fixtures`, () => {
    const config = parseListConfig(binding.tool, binding.config);
    const { normal, dense, empty } = scenarios(listFixtures, binding.tool);
    const rows = rowsOf(dense, config.rows, binding.tool);
    assert.ok(rows.length >= 20, `${binding.tool} · dense has at least 20 rows`);
    assert.equal(
      rowsOf(empty, config.rows, binding.tool).length,
      0,
      `${binding.tool} · empty has no rows`,
    );
    rowsOf(normal, config.rows, binding.tool);

    const keys = rows.map((row) => String(getPath(row, config.rowKey)));
    assert.equal(
      new Set(keys).size,
      rows.length,
      `${binding.tool}: rowKey "${config.rowKey}" is unique`,
    );
    assertFilled(rows, config.title, `${binding.tool} title`);
    // A column may read its orKey when its key is absent (list_traces without includeDetails); an optional one may be absent.
    for (const column of config.columns.filter((item) => !item.optional))
      assertFilled(
        rows,
        column.orKey && !rows.some((row) => getPath(row, column.key) !== undefined)
          ? column.orKey
          : column.key,
        `${binding.tool} column ${column.label}`,
      );
    for (const filter of config.filters ?? [])
      assertFilled(rows, filter.key, `${binding.tool} filter ${filter.label}`);
    // Search keys may be optional (list_traces' ask comes with includeDetails); columns and filters may not.

    if (config.detail) {
      const answer = normal.calls?.[config.detail.tool];
      assert.ok(
        answer,
        `${binding.tool}: the normal fixture answers ${config.detail.tool} for the open row`,
      );
      const firstRow = rowsOf(normal, config.rows, binding.tool)[0];
      const args = detailArgs(config.detail.args, firstRow);
      for (const [name, path] of Object.entries(config.detail.args)) {
        assert.ok(
          name in args,
          `${binding.tool}: a row gives ${config.detail.tool} its ${name} (${path})`,
        );
      }
    }
    if (config.cursor) {
      const next = getPath(dataOf(normal), config.cursor.next);
      assert.ok(
        next === null || typeof next === "string",
        `${binding.tool}: data.${config.cursor.next} is the cursor`,
      );
    }
  });
}

for (const binding of detailView.bindings) {
  test(`detail: ${binding.tool} reads its fixtures`, () => {
    const config = parseDetailConfig(binding.tool, binding.config);
    const { normal, dense, empty } = scenarios(detailFixtures, binding.tool);
    for (const [name, fixture] of Object.entries({ normal, dense, empty })) {
      const root = getPath(dataOf(fixture), config.root);
      assert.ok(
        root && typeof root === "object",
        `${binding.tool} (${name}): data.${config.root || "(itself)"} is the entity`,
      );
      assert.notEqual(
        getPath(root, config.title),
        undefined,
        `${binding.tool} (${name}): the title "${config.title}" is there`,
      );
    }
    const root = getPath(dataOf(dense), config.root);
    for (const field of config.fields)
      assert.notEqual(
        getPath(root, field.key),
        undefined,
        `${binding.tool}: field ${field.label} (${field.key})`,
      );
    for (const section of config.sections ?? []) {
      // As DetailBody reads it: the entity first, then the data around it.
      const value = getPath(root, section.key) ?? getPath(dataOf(dense), section.key);
      if (section.kind === "fields")
        assert.ok(value && typeof value === "object", `${binding.tool}: section ${section.title}`);
      else {
        assert.ok(
          Array.isArray(value) && value.length > 0,
          `${binding.tool} · dense: section ${section.title} (${section.key}) has items`,
        );
        for (const column of section.columns ?? [])
          assertFilled(
            value as Row[],
            column.key,
            `${binding.tool} section ${section.title} column ${column.label}`,
          );
      }
    }
  });
}

for (const binding of seriesView.bindings) {
  test(`series: ${binding.tool} reads its fixtures`, () => {
    const config = parseSeriesConfig(binding.tool, binding.config);
    const { normal, dense, empty } = scenarios(seriesFixtures, binding.tool);
    const rows = rowsOf(dense, config.rows, binding.tool);
    assert.ok(rows.length >= 30, `${binding.tool} · dense has at least 30 points`);
    rowsOf(normal, config.rows, binding.tool);
    assert.equal(
      (getPath(dataOf(empty), config.rows) as unknown[] | undefined)?.length ?? 0,
      0,
      `${binding.tool} · empty has no points`,
    );
    for (const row of rows) {
      assert.match(
        String(getPath(row, config.x)),
        /^\d{4}-\d{2}-\d{2}/,
        `${binding.tool}: x is a day`,
      );
      assert.ok(
        Number.isFinite(Number(getPath(row, config.measure.key))),
        `${binding.tool}: the measure is a number`,
      );
    }
    for (const stat of config.stats) {
      if (stat.aggregate === "window")
        assert.notEqual(
          getPath(dataOf(dense), stat.key),
          undefined,
          `${binding.tool}: stat ${stat.label} reads data.${stat.key}`,
        );
      else assertFilled(rows, stat.key, `${binding.tool} stat ${stat.label}`);
    }
  });
}

test("a tool is bound to one view only", () => {
  const tools = [...listView.bindings, ...detailView.bindings, ...seriesView.bindings].map(
    (binding) => binding.tool,
  );
  assert.equal(new Set(tools).size, tools.length);
});
