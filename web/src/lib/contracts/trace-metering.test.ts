import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { createComposition } from "@/lib/composition";
import { composition } from "@/lib/composition/ports";
import type { AnalysisFilterPort } from "@/lib/contracts/analysis-filter";
import type { TraceMeteringPort } from "@/lib/contracts/trace-metering";

const SCOPE = { organization: { id: "org-1" }, projectId: "proj-1" };

describe("trace metering default", () => {
  it("meters nothing, bounds no span and analyzes every trace", async () => {
    const { traceMetering } = createComposition("oss");
    assert.equal(await traceMetering.isMetered(SCOPE), false);
    assert.deepEqual(
      [
        ...(await traceMetering.meterTraceBatch(
          SCOPE,
          new Map([
            ["a", 1],
            ["b", 1_000_000_000],
          ]),
        )),
      ],
      [
        ["a", "analyzed"],
        ["b", "analyzed"],
      ],
    );
    assert.equal((await traceMetering.meterTraceBatch(SCOPE, new Map())).size, 0);
  });
});

describe("analysis filter default", () => {
  it("filters nothing", async () => {
    const { analysisFilter } = createComposition("oss");
    assert.equal(await analysisFilter.analyzedTraceCondition("proj-1", sql`trace_id`), undefined);
  });
});

describe("an edition", () => {
  // Any complete port set: only the two ports under test matter here.
  const { traceMetering: _m, analysisFilter: _f, ...required } = composition;

  it("keeps the defaults when it supplies neither port", async () => {
    const cloud = createComposition("cloud", { eeComposition: required });
    assert.equal(await cloud.traceMetering.isMetered(SCOPE), false);
    assert.equal(await cloud.analysisFilter.analyzedTraceCondition("p", sql`t`), undefined);
  });

  it("replaces each port", () => {
    const traceMetering: TraceMeteringPort = {
      isMetered: async () => true,
      meterTraceBatch: async () => new Map(),
    };
    const analysisFilter: AnalysisFilterPort = { analyzedTraceCondition: async () => sql`true` };
    const cloud = createComposition("cloud", {
      eeComposition: { ...required, traceMetering, analysisFilter },
    });
    assert.equal(cloud.traceMetering, traceMetering);
    assert.equal(cloud.analysisFilter, analysisFilter);
  });
});
