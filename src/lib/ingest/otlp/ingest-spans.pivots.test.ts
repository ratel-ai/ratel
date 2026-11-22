import assert from "node:assert/strict";
import { test } from "node:test";
import { createPivotKeysLookup, type PivotIngestDeps } from "@/lib/ingest/pivots/ingest";
import { claudeAgentSdkTrace } from "./agent-span-fixtures";
import { type PersistSpansDeps, persistDecodedSpans } from "./ingest-spans";
import type { OtelSpanRow } from "./span-rows";
import type { DecodedSpan } from "./types";

/**
 * RC-883: with `FF_PIVOTS` on, a batch's span rows keep the project's pivot
 * keys, also from the resource. Off, or with no pivots, the rows are as on main.
 * Owned (ADR-0030): the Client company preset reads no vendor group key here
 * (ingest/pivots/model.ts), so the lookup case lists two preset keys.
 */

function harness(pivots?: PivotIngestDeps) {
  const h = { spanRows: [] as OtelSpanRow[], errors: [] as string[] };
  const deps = {
    insertEventsWithMetrics: async (_projectId: string, rows: unknown[]) => rows.length,
    insertTraceEvents: async (_projectId: string, rows: unknown[]) => ({ accepted: rows.length }),
    insertOtelSpans: async (_projectId: string, rows: OtelSpanRow[]) => {
      h.spanRows.push(...rows);
      return { accepted: rows.length };
    },
    ...(pivots ? { pivots } : {}),
    logError: (message: string) => h.errors.push(message),
    captureFailure: () => {},
  } as unknown as PersistSpansDeps;
  return { h, deps };
}

/** The fixture with `tenant.id` on the resource only, and a span-level value on one span. */
function trace(): DecodedSpan[] {
  return claudeAgentSdkTrace().map((span, index) => ({
    ...span,
    resourceAttributes: { ...span.resourceAttributes, "tenant.id": "acme" },
    attributes: index === 1 ? { ...span.attributes, "tenant.id": "globex" } : span.attributes,
  }));
}

async function persist(deps: PersistSpansDeps) {
  const result = await persistDecodedSpans(
    trace(),
    { projectId: "project-1", organization: null, endpoint: "/v1/traces" },
    deps,
  );
  assert.ok(result.ok);
}

function pivotDeps(options: {
  enabled: boolean;
  keys?: string[];
  reads?: { count: number };
}): PivotIngestDeps {
  return {
    enabled: async () => options.enabled,
    loadKeys: async () => {
      if (options.reads) options.reads.count += 1;
      return new Set(options.keys ?? []);
    },
  };
}

test("flag on, tenant.id configured: the resource value is kept, a span-level value wins", async () => {
  const { h, deps } = harness(pivotDeps({ enabled: true, keys: ["tenant.id"] }));
  await persist(deps);
  const values = h.spanRows.map((row) => row.attributes["tenant.id"]);
  assert.ok(values.length > 2);
  assert.equal(values[1], "globex");
  assert.ok(values.every((value, index) => value === (index === 1 ? "globex" : "acme")));
});

test("flag off, no pivots configured, or no pivot deps: the rows equal the rows without pivots", async () => {
  const baseline = harness();
  await persist(baseline.deps);
  assert.ok(baseline.h.spanRows.every((row) => !("tenant.id" in row.attributes)));

  const reads = { count: 0 };
  for (const pivots of [
    pivotDeps({ enabled: false, keys: ["tenant.id"], reads }),
    pivotDeps({ enabled: true, keys: [] }),
  ]) {
    const { h, deps } = harness(pivots);
    await persist(deps);
    assert.deepEqual(h.spanRows, baseline.h.spanRows);
  }
  assert.equal(reads.count, 0, "flag off reads no pivot keys");
});

test("a failed pivot read stores the rows as before and logs the error", async () => {
  const baseline = harness();
  await persist(baseline.deps);
  const { h, deps } = harness({
    enabled: async () => true,
    loadKeys: async () => {
      throw new Error("db down");
    },
  });
  await persist(deps);
  assert.deepEqual(h.spanRows, baseline.h.spanRows);
  assert.deepEqual(h.errors, ["pivot keys read failed"]);
});

test("the lookup reads once per project per minute, shares a read in flight, and forgets a failure", async () => {
  let clock = 0;
  let reads = 0;
  let fail = false;
  const lookup = createPivotKeysLookup(
    async () => {
      reads += 1;
      if (fail) throw new Error("db down");
      return [
        { key: "client", presetId: "client" },
        { key: "customer.tier", presetId: null },
      ];
    },
    { ttlMs: 60_000, now: () => clock },
  );

  const [first, second] = await Promise.all([lookup("p1"), lookup("p1")]);
  assert.deepEqual([...first], ["enduser.org", "tenant.id", "customer.tier"]);
  assert.equal(second, first);
  clock = 59_999;
  await lookup("p1");
  assert.equal(reads, 1);
  await lookup("p2");
  assert.equal(reads, 2);

  clock = 60_000;
  fail = true;
  await assert.rejects(lookup("p1"));
  fail = false;
  await lookup("p1");
  assert.equal(reads, 4);
});
