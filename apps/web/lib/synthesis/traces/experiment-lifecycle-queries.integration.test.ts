import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { toOtelLogRows } from "@/lib/ingest/otlp/log-rows";
import { insertOtelLogs } from "@/lib/ingest/otlp/queries";
import type { DecodedLogRecord } from "@/lib/ingest/otlp/types";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  type ExperimentLifecycleQueriesDb,
  getExperimentConversionMetrics,
  getExperimentLifecycleDiagnostics,
  listExperimentLifecycleArmMetrics,
} from "./experiment-lifecycle-queries";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const SINCE = new Date("2026-07-01T00:00:00.000Z");
const UNTIL = new Date("2026-08-01T00:00:00.000Z");

type TestDb = ExperimentLifecycleQueriesDb & NonNullable<Parameters<typeof insertOtelLogs>[2]>;

test("listExperimentLifecycleArmMetrics aggregates agreement and funnel metrics for shadow arms", async () => {
  const { client, db } = await setup();
  await insertRecords(db, PROJECT_ID, [
    lifecycleRecord("comparison", "candidate", "2026-07-10T10:00:00.000Z", {
      "ratel.experiment.agreement.top1": true,
      "ratel.experiment.agreement.exact_order": true,
      "ratel.experiment.agreement.jaccard_at_k": 0.75,
      "ratel.experiment.agreement.k": 5,
    }),
    lifecycleRecord("comparison", "candidate", "2026-07-10T10:01:00.000Z", {
      "ratel.experiment.agreement.top1": false,
      "ratel.experiment.agreement.exact_order": true,
      "ratel.experiment.agreement.jaccard_at_k": 0.25,
      "ratel.experiment.agreement.k": 5,
    }),
    lifecycleRecord("skip", "candidate", "2026-07-10T10:02:00.000Z"),
    lifecycleRecord("fallback", "candidate", "2026-07-10T10:03:00.000Z"),
    lifecycleRecord("drop", "candidate", "2026-07-10T10:04:00.000Z", {
      "ratel.experiment.drop.reason": "timeout",
    }),
    lifecycleRecord("drop", "candidate", "2026-07-10T10:05:00.000Z", {
      "ratel.experiment.drop.reason": "timeout",
    }),
    lifecycleRecord("drop", "candidate", "2026-07-10T10:06:00.000Z", {
      "ratel.experiment.drop.reason": "quota",
    }),
    lifecycleRecord("results", "empty-shadow", "2026-07-10T10:07:00.000Z"),
    lifecycleRecord("comparison", "serving", "2026-07-10T10:08:00.000Z", {}, "serving"),
    lifecycleRecord("comparison", "outside", "2026-08-02T10:00:00.000Z"),
    lifecycleRecord("comparison", "other-experiment", "2026-07-10T10:09:00.000Z", {
      "ratel.experiment.id": "other",
    }),
  ]);
  await insertRecords(db, OTHER_PROJECT_ID, [
    lifecycleRecord("comparison", "other-project", "2026-07-10T10:10:00.000Z"),
  ]);

  assert.deepEqual(
    await listExperimentLifecycleArmMetrics(
      PROJECT_ID,
      "ranking",
      { since: SINCE, until: UNTIL },
      db,
    ),
    [
      {
        arm: "candidate",
        role: "shadow",
        comparisonCount: 2,
        top1Rate: 0.5,
        exactOrderRate: 1,
        averageJaccardAtK: 0.5,
        agreementK: 5,
        skipCount: 1,
        fallbackCount: 1,
        dropCount: 3,
        dropsByReason: { quota: 1, timeout: 2 },
        shadowCoverage: 1 / 3,
      },
      {
        arm: "empty-shadow",
        role: "shadow",
        comparisonCount: 0,
        top1Rate: null,
        exactOrderRate: null,
        averageJaccardAtK: null,
        agreementK: null,
        skipCount: 0,
        fallbackCount: 0,
        dropCount: 0,
        dropsByReason: {},
        shadowCoverage: null,
      },
    ],
  );
  await client.close();
});

test("getExperimentLifecycleDiagnostics reports window activity and the project's latest lifecycle event", async () => {
  const { client, db } = await setup();
  await insertRecords(db, PROJECT_ID, [
    lifecycleRecord("results", "candidate", "2026-07-10T10:00:00.000Z"),
    lifecycleRecord("drop", "candidate", "2026-08-02T10:00:00.000Z"),
  ]);
  await insertRecords(db, OTHER_PROJECT_ID, [
    lifecycleRecord("comparison", "candidate", "2026-09-01T10:00:00.000Z"),
  ]);

  assert.deepEqual(
    await getExperimentLifecycleDiagnostics(PROJECT_ID, { since: SINCE, until: UNTIL }, db),
    {
      hasLifecycleEvents: true,
      latestLogAt: new Date("2026-08-02T10:00:00.000Z"),
    },
  );
  assert.deepEqual(
    await getExperimentLifecycleDiagnostics(
      PROJECT_ID,
      {
        since: new Date("2026-09-01T00:00:00.000Z"),
        until: new Date("2026-10-01T00:00:00.000Z"),
      },
      db,
    ),
    {
      hasLifecycleEvents: false,
      latestLogAt: new Date("2026-08-02T10:00:00.000Z"),
    },
  );
  await client.close();
});

test("getExperimentConversionMetrics attributes outcomes and invocations to effective arms without dropping unknowns", async () => {
  const { client, db } = await setup();
  await insertRecords(db, PROJECT_ID, [
    lifecycleRecord(
      "results",
      "control",
      "2026-06-30T23:59:00.000Z",
      {
        "ratel.experiment.selection_id": "selection-control",
      },
      "serving",
    ),
    conversionRecord("outcome", "selection-control", "2026-07-10T10:00:00.000Z", {
      "ratel.experiment.outcome.label": "accepted",
      "ratel.experiment.outcome.score": 0.8,
    }),
    conversionRecord("outcome", "selection-control", "2026-07-10T10:01:00.000Z", {
      "ratel.experiment.outcome.score": 1,
    }),
    conversionRecord("invocation", "selection-control", "2026-07-10T10:02:00.000Z", {
      "ratel.experiment.invocation.attributed": true,
      "ratel.experiment.effective_arm": "control",
      "ratel.experiment.invocation.rank": 0,
      "ratel.experiment.invocation.age_ms": 200,
    }),
    conversionRecord("invocation", "selection-control", "2026-07-10T10:03:00.000Z", {
      "ratel.experiment.invocation.attributed": true,
      "ratel.experiment.effective_arm": "control",
      "ratel.experiment.invocation.rank": -1,
      "ratel.experiment.invocation.age_ms": 400,
    }),
    lifecycleRecord(
      "results",
      "candidate",
      "2026-07-10T09:55:00.000Z",
      {
        "ratel.experiment.selection_id": "selection-fallback",
      },
      "serving",
    ),
    lifecycleRecord(
      "fallback",
      "candidate",
      "2026-07-10T09:56:00.000Z",
      {
        "ratel.experiment.selection_id": "selection-fallback",
        "ratel.experiment.fallback.effective_arm": "control",
      },
      "serving",
    ),
    conversionRecord("outcome", "selection-fallback", "2026-07-10T10:04:00.000Z", {
      "ratel.experiment.outcome.label": "converted",
      "ratel.experiment.outcome.score": 0.5,
    }),
    conversionRecord("invocation", "selection-fallback", "2026-07-10T10:05:00.000Z", {
      "ratel.experiment.invocation.attributed": true,
      "ratel.experiment.effective_arm": "control",
      "ratel.experiment.invocation.rank": 1,
      "ratel.experiment.invocation.age_ms": 600,
    }),
    conversionRecord("outcome", "missing-selection", "2026-07-10T10:06:00.000Z", {
      "ratel.experiment.outcome.label": "unknown",
      "ratel.experiment.outcome.score": 0.1,
    }),
    conversionRecord("invocation", null, "2026-07-10T10:07:00.000Z", {
      "ratel.experiment.invocation.attributed": false,
    }),
    conversionRecord("outcome", "selection-control", "2026-08-02T10:00:00.000Z", {
      "ratel.experiment.outcome.label": "outside",
    }),
  ]);
  await insertRecords(db, OTHER_PROJECT_ID, [
    conversionRecord("invocation", null, "2026-07-10T10:08:00.000Z", {
      "ratel.experiment.invocation.attributed": false,
    }),
  ]);

  assert.deepEqual(
    await getExperimentConversionMetrics(PROJECT_ID, "ranking", { since: SINCE, until: UNTIL }, db),
    {
      arms: [
        {
          arm: "control",
          outcomeCount: 3,
          outcomesByLabel: { accepted: 1, converted: 1 },
          unlabeledOutcomeCount: 1,
          averageOutcomeScore: (0.8 + 1 + 0.5) / 3,
          invocationCount: 3,
          servedInvocationCount: 2,
          notServedInvocationCount: 1,
          invocationRankHistogram: { "-1": 1, "0": 1, "1": 1 },
          averageInvocationAgeMs: 400,
        },
      ],
      invocationCount: 4,
      attributedInvocationCount: 3,
      unattributedInvocationCount: 1,
      invocationAttributionRate: 0.75,
      unresolvedOutcomeCount: 1,
    },
  );
  await client.close();
});

async function setup(): Promise<{ client: PGlite; db: TestDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug)
    values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  return {
    client,
    db: drizzle(client, { schema }) as unknown as TestDb,
  };
}

async function insertRecords(
  db: TestDb,
  projectId: string,
  records: DecodedLogRecord[],
): Promise<void> {
  const { rows, dropped } = toOtelLogRows(projectId, records);
  assert.equal(dropped, 0);
  assert.deepEqual(await insertOtelLogs(projectId, rows, db), {
    accepted: rows.length,
  });
}

function lifecycleRecord(
  event: "results" | "comparison" | "skip" | "fallback" | "drop",
  arm: string,
  occurredAt: string,
  attributes: Record<string, unknown> = {},
  role = "shadow",
): DecodedLogRecord {
  const occurredAtMs = Date.parse(occurredAt);
  return {
    eventName: `ratel.experiment.${event}`,
    timeUnixNano: (BigInt(occurredAtMs) * BigInt(1_000_000)).toString(),
    timeUnixMs: occurredAtMs,
    observedTimeUnixNano: "",
    observedTimeUnixMs: 0,
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    severityNumber: 9,
    severityText: "INFO",
    body: null,
    attributes: {
      "ratel.experiment.id": "ranking",
      "ratel.experiment.selection_id": `${arm}-${occurredAtMs}`,
      "ratel.experiment.arm": arm,
      "ratel.experiment.role": role,
      ...attributes,
    },
    resourceAttributes: { "service.name": "fixture-agent" },
    scopeName: "@ratel-ai/sdk",
  };
}

function conversionRecord(
  event: "invocation" | "outcome",
  selectionId: string | null,
  occurredAt: string,
  attributes: Record<string, unknown>,
): DecodedLogRecord {
  const occurredAtMs = Date.parse(occurredAt);
  return {
    eventName: `ratel.experiment.${event}`,
    timeUnixNano: (BigInt(occurredAtMs) * BigInt(1_000_000)).toString(),
    timeUnixMs: occurredAtMs,
    observedTimeUnixNano: "",
    observedTimeUnixMs: 0,
    traceId: null,
    spanId: null,
    severityNumber: 9,
    severityText: "INFO",
    body: null,
    attributes: {
      "ratel.experiment.id": "ranking",
      ...(selectionId === null ? {} : { "ratel.experiment.selection_id": selectionId }),
      ...attributes,
    },
    resourceAttributes: { "service.name": "fixture-agent" },
    scopeName: "@ratel-ai/sdk",
  };
}
