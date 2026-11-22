import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { sourceOf } from "@/lib/views/lineage/resolve";
import {
  createDrizzleDatasetStore,
  createDrizzleOverrideStore,
} from "../adapters/drizzle-dataset-store";
import {
  type BuildJobPayload,
  type DatasetBuildDeps,
  type DatasetEvent,
  runDatasetBuild,
  startDatasetBuild,
} from "../build";
import { datasetBuildDeps } from "../build-deps";
import { viewOfDataset } from "../domain/dataset";
import {
  type DatasetLifecycleEvent,
  type ExportApiDeps,
  handleDatasetDeleteRequest,
  handleDatasetExportRequest,
  handleDatasetGetRequest,
  ROWS_HEADER,
  SKIPPED_HEADER,
  SKIPPED_REASONS_HEADER,
} from "../export-api";
import {
  handleDatasetRowsRequest,
  handleOverridesRequest,
  type OverrideEvent,
  type ReviewApiDeps,
} from "../review-api";

/**
 * RC-1128: a dataset build on embedded Postgres. Seeded:
 * - project A (opt-in given), task `triage`, six closed turns, one call each:
 *   sessions s1 (turns 1, 2), s2 (turn 3), s3 (turns 4, 5), s4 (turn 6).
 *   End users cross sessions: u1 on turns 1 and 3 (s1, s2), u2 on turns 4
 *   and 6 (s3, s4); turns 2 and 5 have none. Turn 6 asks exactly what turn 1
 *   asks. The asks hold the fixture PII.
 * - project B (opt-in given), task `triage`, one closed turn.
 * - project C (no opt-in), task `triage`, one closed turn.
 * - project D (opt-in given), task `triage`, three interleaved turns (RC-1145):
 *   A 10:00-10:10 asks "same ask" at 10:00:30 and "alpha" at 10:09;
 *   B 10:01:30-10:09:30 asks "same ask" at 10:05; C 10:01-10:11 asks "beta"
 *   at 10:02 and "same ask" at 10:10:30. By end time B comes before A.
 *   (Similar lengths: the default latency scorer keeps all three.)
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "33333333-3333-4333-8333-333333333333";
const PROJECT_C = "55555555-5555-4555-8555-555555555555";
const PROJECT_D = "66666666-6666-4666-8666-666666666666";
const T0 = Date.parse("2026-11-10T09:00:00.000Z");
const NOW = new Date("2026-11-20T00:00:00.000Z");

const PII = {
  email: "anna.rossi@example.com",
  phone: "+39 333 123 4567",
  card: "4111 1111 1111 1111",
  key: "sk-" + "ant-api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
};

const ASKS = [
  `I am ${PII.email}, refund order 1`,
  `call me on ${PII.phone}`,
  `my card is ${PII.card}`,
  `the key ${PII.key} leaked`,
  "where is my parcel?",
  `I am ${PII.email}, refund order 1`,
];

type TestDb = NonNullable<Parameters<typeof datasetBuildDeps>[0]>;

interface Harness {
  client: PGlite;
  db: TestDb;
  queued: { projectId: string; payload: BuildJobPayload }[];
  events: DatasetEvent[];
  deps: (overrides?: Partial<DatasetBuildDeps>) => DatasetBuildDeps;
  useCases: Record<string, string>;
}

test("a build stores rows, counts, settings, the redaction report and the content hash, and ends ready", async () => {
  const h = await seeded();
  try {
    const started = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      { seed: 7, evalFraction: 0.5 },
      "user_1",
      h.deps(),
    );
    assert.ok(started.ok);
    assert.equal(started.dataset.status, "building");
    assert.equal(started.dataset.version, 1);
    assert.deepEqual(h.queued, [
      { projectId: PROJECT_A, payload: { datasetId: started.dataset.id } },
    ]);

    const run = await runDatasetBuild(PROJECT_A, h.queued[0]!.payload, h.deps());
    assert.equal(run.built, true);

    const dataset = await createDrizzleDatasetStore(h.db).getDataset(PROJECT_A, started.dataset.id);
    assert.equal(dataset?.status, "ready");
    assert.match(dataset?.contentHash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(dataset?.settings.redactionVersion, 1);
    assert.equal(dataset?.settings.seed, 7);
    assert.equal(dataset?.settings.dedup, "near");
    assert.equal(dataset!.counts!.turns, 6);
    assert.equal(dataset!.counts!.train + dataset!.counts!.eval, 5);
    assert.equal(dataset!.counts!.dropped.duplicate_exact, 1);
    assert.deepEqual(dataset?.redactionReport, {
      secret: 1,
      email: 1,
      iban: 0,
      payment_card: 1,
      national_id: 0,
      phone: 1,
    });

    const rows = await rowsOf(h.client, started.dataset.id);
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.map((row) => row.ordinal),
      [0, 1, 2, 3, 4],
    );
    assert.deepEqual(rows[0]?.content, {
      messages: [{ role: "user", content: "I am [EMAIL_1], refund order 1" }],
      output: [{ role: "assistant", content: "ok" }],
    });
    assert.deepEqual(
      h.events.map((event) => event.name),
      ["dataset_build_started", "dataset_built"],
    );
  } finally {
    await h.client.close();
  }
});

test("no stored row holds a fixture email, phone number, card number or key, and no session and no end user is on both sides", async () => {
  const h = await seeded();
  try {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const started = await startDatasetBuild(
        PROJECT_A,
        h.useCases[PROJECT_A]!,
        { seed, evalFraction: 0.5, dedup: "off" },
        "user_1",
        h.deps(),
      );
      assert.ok(started.ok);
      await runDatasetBuild(PROJECT_A, { datasetId: started.dataset.id }, h.deps());
    }
    const all = (
      await h.client.query<{ content: unknown }>("select content from fine_tuning_dataset_rows")
    ).rows;
    assert.equal(all.length, 60);
    const text = JSON.stringify(all);
    for (const value of Object.values(PII)) assert.equal(text.includes(value), false, value);
    assert.equal(text.includes("4111111111111111"), false);

    const mixed = await h.client.query<{ dataset_id: string; session_id: string }>(`
      select r.dataset_id, t.session_id
      from fine_tuning_dataset_rows r join trace_turns t on t.id = r.turn_id
      group by r.dataset_id, t.session_id
      having count(distinct r.side) > 1
    `);
    assert.deepEqual(mixed.rows, []);
    const mixedUsers = await h.client.query<{ dataset_id: string; end_user_key: string }>(`
      select r.dataset_id, t.end_user_key
      from fine_tuning_dataset_rows r join trace_turns t on t.id = r.turn_id
      where t.end_user_key is not null
      group by r.dataset_id, t.end_user_key
      having count(distinct r.side) > 1
    `);
    assert.deepEqual(mixedUsers.rows, []);
    // Not passed by one-sided builds: some datasets have both sides.
    const twoSided = await h.client.query<{ n: number }>(
      "select count(*)::int as n from (select dataset_id from fine_tuning_dataset_rows group by 1 having count(distinct side) = 2) x",
    );
    assert.ok(twoSided.rows[0]!.n > 0);
  } finally {
    await h.client.close();
  }
});

test("two builds with the same settings on the same traces have the same content hash; a build that stops after one page resumes to it", async () => {
  const h = await seeded();
  try {
    const settings = { seed: 3, evalFraction: 0.3 };
    const whole = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      settings,
      "user_1",
      h.deps(),
    );
    assert.ok(whole.ok);
    const wholeRun = await runDatasetBuild(PROJECT_A, { datasetId: whole.dataset.id }, h.deps());
    assert.ok(wholeRun.built);

    const paged = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      settings,
      "user_1",
      h.deps(),
    );
    assert.ok(paged.ok);
    assert.equal(paged.dataset.version, 2);
    const pagedDeps = h.deps({ pageCalls: 2, maxPagesPerRun: 1 });
    const runs = [];
    for (let i = 0; i < 5; i += 1) {
      const run = await runDatasetBuild(PROJECT_A, { datasetId: paged.dataset.id }, pagedDeps);
      runs.push(run.built ? "built" : run.reason);
      if (run.built) {
        assert.equal(run.contentHash, wholeRun.contentHash);
        break;
      }
    }
    assert.deepEqual(runs, ["continued", "continued", "built"]);
    assert.equal(
      h.queued.filter((job) => job.payload.datasetId === paged.dataset.id).length,
      3,
      "the start and two continuations",
    );

    const store = createDrizzleDatasetStore(h.db);
    const [a, b] = [
      await store.getDataset(PROJECT_A, whole.dataset.id),
      await store.getDataset(PROJECT_A, paged.dataset.id),
    ];
    assert.deepEqual(b?.counts, a?.counts);
    assert.deepEqual(b?.redactionReport, a?.redactionReport);
  } finally {
    await h.client.close();
  }
});

test("with the flag off or no opt-in, a start is refused and stores nothing; the job fails with a typed reason and keeps no row", async () => {
  const h = await seeded();
  try {
    const flagOff = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      {},
      "user_1",
      h.deps({ flagOn: async () => false }),
    );
    assert.deepEqual(flagOff.ok ? null : flagOff.reason, "flag_off");
    const noConsent = await startDatasetBuild(
      PROJECT_C,
      h.useCases[PROJECT_C]!,
      {},
      "user_1",
      h.deps(),
    );
    assert.deepEqual(noConsent.ok ? null : noConsent.reason, "no_consent");
    assert.match(noConsent.ok ? "" : noConsent.message, /opt-in/);
    assert.equal(await count(h.client, "fine_tuning_datasets"), 0);
    assert.deepEqual(h.queued, []);

    // Queued with the guards met, then the flag goes off before the job runs.
    const started = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      {},
      "user_1",
      h.deps(),
    );
    assert.ok(started.ok);
    const off = await runDatasetBuild(
      PROJECT_A,
      { datasetId: started.dataset.id },
      h.deps({ flagOn: async () => false }),
    );
    assert.deepEqual(off, { built: false, datasetId: started.dataset.id, reason: "flag_off" });

    // Queued, then the opt-in is withdrawn.
    const second = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      {},
      "user_1",
      h.deps(),
    );
    assert.ok(second.ok);
    await h.client.query(
      "update fine_tuning_consents set withdrawn_at = now(), withdrawn_by = 'user_1' where project_id = $1",
      [PROJECT_A],
    );
    const withdrawn = await runDatasetBuild(PROJECT_A, { datasetId: second.dataset.id }, h.deps());
    assert.deepEqual(withdrawn, {
      built: false,
      datasetId: second.dataset.id,
      reason: "no_consent",
    });

    const store = createDrizzleDatasetStore(h.db);
    assert.equal((await store.getDataset(PROJECT_A, started.dataset.id))?.failedReason, "flag_off");
    assert.equal((await store.getDataset(PROJECT_A, second.dataset.id))?.status, "failed");
    assert.equal(await count(h.client, "fine_tuning_dataset_rows"), 0);
  } finally {
    await h.client.close();
  }
});

test("over the row cap, the build fails with too_large and keeps no row", async () => {
  const h = await seeded();
  try {
    const started = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      {},
      "user_1",
      h.deps(),
    );
    assert.ok(started.ok);
    const run = await runDatasetBuild(
      PROJECT_A,
      { datasetId: started.dataset.id },
      h.deps({ rowCap: 2, pageCalls: 2 }),
    );
    assert.deepEqual(run, { built: false, datasetId: started.dataset.id, reason: "too_large" });
    assert.equal(await count(h.client, "fine_tuning_dataset_rows"), 0);
  } finally {
    await h.client.close();
  }
});

test("a ready dataset is immutable: appendRows is refused and the database refuses a row update", async () => {
  const h = await seeded();
  try {
    const started = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      {},
      "user_1",
      h.deps(),
    );
    assert.ok(started.ok);
    await runDatasetBuild(PROJECT_A, { datasetId: started.dataset.id }, h.deps());
    const store = createDrizzleDatasetStore(h.db);
    const before = await rowsOf(h.client, started.dataset.id);
    const extra = {
      ordinal: 99,
      side: "train" as const,
      content: { messages: [], output: [] },
      rowHash: "x",
      traceId: "t",
      spanId: "s",
      turnId: PROJECT_A,
      capturedAt: NOW,
    };
    const progress = {
      counts: {
        turns: 0,
        calls: 0,
        cursor: null,
        train: 0,
        eval: 0,
        dropped: started.dataset.counts?.dropped ?? ({} as never),
      },
      redaction: {} as never,
    };
    assert.equal(await store.appendRows(PROJECT_A, started.dataset.id, [extra], progress), false);
    assert.equal(
      await store.markReady(PROJECT_A, started.dataset.id, { contentHash: "x", ...progress }),
      false,
    );
    assert.equal(await store.markFailed(PROJECT_A, started.dataset.id, "too_large"), false);
    await assert.rejects(
      h.client.query("update fine_tuning_dataset_rows set side = 'eval' where dataset_id = $1", [
        started.dataset.id,
      ]),
      /immutable/,
    );
    assert.deepEqual(await rowsOf(h.client, started.dataset.id), before);
  } finally {
    await h.client.close();
  }
});

test("no source file updates a stored dataset row", () => {
  const offenders = sourceFiles(path.resolve(import.meta.dirname, "../../..")).filter((file) =>
    /update\s+"?fine_tuning_dataset_rows|update\(\s*fineTuningDatasetRows/i.test(
      readFileSync(file, "utf8"),
    ),
  );
  assert.deepEqual(offenders, []);
});

test("withdrawing the opt-in deletes the datasets and rows of that project only", async () => {
  const h = await seeded();
  try {
    for (const projectId of [PROJECT_A, PROJECT_B]) {
      const started = await startDatasetBuild(
        projectId,
        h.useCases[projectId]!,
        {},
        "user_1",
        h.deps(),
      );
      assert.ok(started.ok);
      assert.ok(
        (await runDatasetBuild(projectId, { datasetId: started.dataset.id }, h.deps())).built,
      );
    }
    assert.equal(await createDrizzleDatasetStore(h.db).deleteDatasets(PROJECT_A), 1);
    const left = await h.client.query<{ project_id: string; rows: number }>(`
      select d.project_id, (select count(*)::int from fine_tuning_dataset_rows r where r.dataset_id = d.id) as rows
      from fine_tuning_datasets d
    `);
    assert.deepEqual(left.rows, [{ project_id: PROJECT_B, rows: 1 }]);
    assert.equal(await count(h.client, "fine_tuning_dataset_rows"), 1);
  } finally {
    await h.client.close();
  }
});

test("a built dataset names its use case's first task as its source in the lineage", async () => {
  const h = await seeded();
  try {
    const started = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      {},
      "user_1",
      h.deps(),
    );
    assert.ok(started.ok);
    await runDatasetBuild(PROJECT_A, { datasetId: started.dataset.id }, h.deps());
    const source = await sourceOf(
      { stage: "improve", kind: "dataset", id: started.dataset.id },
      { projectId: PROJECT_A, db: h.db as never },
    );
    assert.deepEqual(
      { stage: source?.stage, kind: source?.kind, id: source?.id },
      { stage: "insights", kind: "task", id: "triage" },
    );
  } finally {
    await h.client.close();
  }
});

async function seeded(): Promise<Harness> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_A}', '${ORGANIZATION_ID}', 'A', 'a'), ('${PROJECT_B}', '${ORGANIZATION_ID}', 'B', 'b'), ('${PROJECT_C}', '${ORGANIZATION_ID}', 'C', 'c'),
      ('${PROJECT_D}', '${ORGANIZATION_ID}', 'D', 'd');
    insert into fine_tuning_consents (project_id, given_by, text_version) values ('${PROJECT_A}', 'user_1', 'v1'), ('${PROJECT_B}', 'user_1', 'v1'), ('${PROJECT_D}', 'user_1', 'v1');
  `);
  const db = drizzle(client, { schema }) as unknown as TestDb;
  const useCases: Record<string, string> = {};
  for (const projectId of [PROJECT_A, PROJECT_B, PROJECT_C, PROJECT_D]) {
    const { rows } = await client.query<{ id: string }>(
      `insert into fine_tuning_use_cases (project_id, name, selector, created_by) values ($1, 'Triage', $2::jsonb, 'user_1') returning id`,
      [projectId, JSON.stringify({ taskIds: ["triage"], intentIds: [] })],
    );
    useCases[projectId] = rows[0]!.id;
  }
  // trace index, project, session, end user, ask
  const turns: [number, string, string, string | null, string][] = [
    ...ASKS.map((ask, i): [number, string, string, string | null, string] => [
      i + 1,
      PROJECT_A,
      ["s1", "s1", "s2", "s3", "s3", "s4"][i]!,
      ["u1", null, "u1", "u2", null, "u2"][i]!,
      ask,
    ]),
    [7, PROJECT_B, "b1", null, "hello from B"],
    [8, PROJECT_C, "c1", null, "hello from C"],
  ];
  for (const [index, project, session, endUser, ask] of turns) {
    const minutes = index * 10;
    const start = new Date(T0 + minutes * 60_000).toISOString();
    const end = new Date(T0 + minutes * 60_000 + 30_000).toISOString();
    await client.query(
      `insert into trace_turns (project_id, session_id, end_user_key, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
       values ($1, $2, $3, $4, 'otlp', 'otlp', 'closed', $5, $6, $6, 'triage')`,
      [project, session, endUser, `otlp:${traceId(index)}`, start, end],
    );
    await insertOtelSpans(project, [span(index * 10, project, index, minutes)], db as never);
    const payload = {
      provider: "anthropic",
      model: "claude-haiku",
      ts: start,
      messages: [{ role: "user", content: ask }],
      output: [{ role: "assistant", content: "ok" }],
    };
    await client.query(
      `insert into events (project_id, occurred_at, model, cost_usd, trace_id, span_id, payload) values ($1, $2, 'claude-haiku', '0.001', $3, $4, $5::jsonb)`,
      [
        project,
        new Date(T0 + minutes * 60_000 + 1_000).toISOString(),
        traceId(index),
        spanId(index * 10 + 1),
        JSON.stringify(payload),
      ],
    );
  }
  // Project D: interleaved turns. trace index, session, start, end, calls [span index, ask, time].
  const interleaved: [number, string, string, string, [number, string, string][]][] = [
    [
      9,
      "dA",
      "10:00:00",
      "10:10:00",
      [
        [91, "same ask", "10:00:30"],
        [92, "alpha", "10:09:00"],
      ],
    ],
    [10, "dB", "10:01:30", "10:09:30", [[101, "same ask", "10:05:00"]]],
    [
      11,
      "dC",
      "10:01:00",
      "10:11:00",
      [
        [111, "beta", "10:02:00"],
        [112, "same ask", "10:10:30"],
      ],
    ],
  ];
  const clock = (time: string) => `2026-11-10T${time}.000Z`;
  for (const [index, session, start, end, calls] of interleaved) {
    await client.query(
      `insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
       values ($1, $2, $3, 'otlp', 'otlp', 'closed', $4, $5, $5, 'triage')`,
      [PROJECT_D, session, `otlp:${traceId(index)}`, clock(start), clock(end)],
    );
    await insertOtelSpans(
      PROJECT_D,
      [
        {
          ...span(index * 10, PROJECT_D, index, 0),
          startedAt: new Date(clock(start)),
          endedAt: new Date(clock(end)),
        },
      ],
      db as never,
    );
    for (const [spanIndex, ask, time] of calls) {
      const payload = {
        provider: "anthropic",
        model: "claude-haiku",
        ts: clock(time),
        messages: [{ role: "user", content: ask }],
        output: [{ role: "assistant", content: "ok" }],
      };
      await client.query(
        `insert into events (project_id, occurred_at, model, cost_usd, trace_id, span_id, payload) values ($1, $2, 'claude-haiku', '0.001', $3, $4, $5::jsonb)`,
        [PROJECT_D, clock(time), traceId(index), spanId(spanIndex), JSON.stringify(payload)],
      );
    }
  }
  const queued: Harness["queued"] = [];
  const events: DatasetEvent[] = [];
  const deps = (overrides: Partial<DatasetBuildDeps> = {}): DatasetBuildDeps => ({
    ...datasetBuildDeps(db),
    flagOn: async () => true,
    enqueue: async (projectId, payload) => {
      queued.push({ projectId, payload });
    },
    track: async (event) => {
      events.push(event);
    },
    now: () => NOW,
    ...overrides,
  });
  return { client, db, queued, events, deps, useCases };
}

async function rowsOf(client: PGlite, datasetId: string) {
  return (
    await client.query<{ ordinal: number; side: string; content: unknown; row_hash: string }>(
      "select ordinal, side, content, row_hash from fine_tuning_dataset_rows where dataset_id = $1 order by ordinal",
      [datasetId],
    )
  ).rows;
}

async function count(client: PGlite, table: string): Promise<number> {
  return (await client.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory())
      return ["node_modules", ".next", "tests"].includes(name) ? [] : sourceFiles(full);
    return /\.(ts|tsx|sql)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

function traceId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

function spanId(index: number): string {
  return index.toString(16).padStart(16, "0");
}

function span(index: number, projectId: string, trace: number, minutes: number): NewOtelSpan {
  const startedAt = new Date(T0 + minutes * 60_000 + index * 100);
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    projectId,
    receivedAt: startedAt,
    traceId: traceId(trace),
    spanId: spanId(index),
    parentSpanId: null,
    name: "invoke_agent",
    kind: 1,
    spanClass: "other",
    startedAt,
    endedAt: new Date(startedAt.getTime() + 50),
    durationMs: 50,
    statusCode: 1,
    serviceName: null,
    scopeName: "fixture",
    operationName: null,
    providerName: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    costUsd: null,
    searchOrigin: null,
    searchTarget: null,
    searchQuery: null,
    searchTopK: null,
    searchHitCount: null,
    experimentName: null,
    experimentArm: null,
    experimentRole: null,
    experimentAttrs: {},
    attributes: {},
    attrsTruncated: false,
  };
}

test("interleaved turns: the earliest duplicate call by capture time stays, in one go and in pages of one call", async () => {
  const h = await seeded();
  try {
    const whole = await startDatasetBuild(
      PROJECT_D,
      h.useCases[PROJECT_D]!,
      { dedup: "exact" },
      "user_1",
      h.deps(),
    );
    assert.ok(whole.ok);
    const wholeRun = await runDatasetBuild(PROJECT_D, { datasetId: whole.dataset.id }, h.deps());
    assert.ok(wholeRun.built);
    const spansOf = async (datasetId: string) =>
      (
        await h.client.query<{ span_id: string }>(
          "select span_id from fine_tuning_dataset_rows where dataset_id = $1 order by ordinal",
          [datasetId],
        )
      ).rows.map((row) => row.span_id);
    // Kept, in capture order: A's 10:00:30 "same ask", C's 10:02 "beta", A's 10:09 "alpha".
    // Dropped: B's 10:05 and C's 10:10:30 "same ask".
    assert.deepEqual(await spansOf(whole.dataset.id), [spanId(91), spanId(111), spanId(92)]);

    const paged = await startDatasetBuild(
      PROJECT_D,
      h.useCases[PROJECT_D]!,
      { dedup: "exact" },
      "user_1",
      h.deps(),
    );
    assert.ok(paged.ok);
    const deps = h.deps({ pageCalls: 1, maxPagesPerRun: 1 });
    const runs: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const run = await runDatasetBuild(PROJECT_D, { datasetId: paged.dataset.id }, deps);
      runs.push(run.built ? "built" : run.reason);
      if (run.built) {
        assert.equal(run.contentHash, wholeRun.contentHash);
        break;
      }
    }
    assert.deepEqual(runs, ["continued", "continued", "continued", "continued", "built"]);
    assert.deepEqual(await spansOf(paged.dataset.id), [spanId(91), spanId(111), spanId(92)]);

    const store = createDrizzleDatasetStore(h.db);
    const [a, b] = [
      await store.getDataset(PROJECT_D, whole.dataset.id),
      await store.getDataset(PROJECT_D, paged.dataset.id),
    ];
    assert.equal(a?.counts?.dropped.duplicate_exact, 2);
    assert.equal(b?.counts?.dropped.duplicate_exact, 2);
    assert.deepEqual(b?.counts, a?.counts);
  } finally {
    await h.client.close();
  }
});

test("RC-1130: an excluded run is absent from the next build and stays in the earlier version; a pinned run that fails a scorer is in the next build", async () => {
  const h = await seeded();
  try {
    const settings = { dedup: "off" as const, evalFraction: 0 };
    const first = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      settings,
      "user_1",
      h.deps(),
    );
    assert.ok(first.ok);
    assert.ok((await runDatasetBuild(PROJECT_A, { datasetId: first.dataset.id }, h.deps())).built);
    const before = await rowsOf(h.client, first.dataset.id);
    const turn = await turnsBySession(h.client, PROJECT_A);
    assert.equal(new Set(await turnIdsOf(h.client, first.dataset.id)).size, 6);

    // Turn 3 (s2) is excluded. Turns 2 and 5 fail a user scorer; turn 5 is pinned.
    const overrides = createDrizzleOverrideStore(h.db);
    assert.ok(
      (
        await overrides.setOverride(
          PROJECT_A,
          h.useCases[PROJECT_A]!,
          { turnId: turn.s2[0]!, excluded: true },
          "user_1",
        )
      ).ok,
    );
    assert.ok(
      (
        await overrides.setOverride(
          PROJECT_A,
          h.useCases[PROJECT_A]!,
          { turnId: turn.s3[1]!, pinned: true },
          "user_1",
        )
      ).ok,
    );
    // Owned (ADR-0030): the core has no user scorers (the Evals area), so the two failing user
    // scorer results come from the build's fact source instead of `scorers` and `run_scores` rows.
    const base = h.deps();
    const failing = new Set([turn.s1[1]!, turn.s3[1]!]);
    const withUserFails = h.deps({
      facts: {
        ...base.facts,
        userScores: async (_projectId, turnIds) =>
          new Map(
            turnIds
              .filter((id) => failing.has(id))
              .map((id) => [id, [{ status: "fail" as const }]]),
          ),
      },
    });

    const second = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      settings,
      "user_1",
      withUserFails,
    );
    assert.ok(second.ok);
    assert.deepEqual(second.dataset.settings.overrides, {
      pinned: [turn.s3[1]!],
      excluded: [turn.s2[0]!],
    });
    assert.ok(
      (await runDatasetBuild(PROJECT_A, { datasetId: second.dataset.id }, withUserFails)).built,
    );
    const next = new Set(await turnIdsOf(h.client, second.dataset.id));
    assert.equal(next.has(turn.s2[0]!), false, "the excluded run is not in the next build");
    assert.equal(next.has(turn.s1[1]!), false, "a run that fails a scorer is dropped");
    assert.equal(next.has(turn.s3[1]!), true, "the pinned run that fails a scorer is kept");
    assert.equal(next.size, 4);
    const counts = (await createDrizzleDatasetStore(h.db).getDataset(PROJECT_A, second.dataset.id))!
      .counts!;
    assert.equal(counts.dropped.excluded, 1);
    assert.equal(counts.dropped.user_scorer_failed, 1);

    assert.deepEqual(
      await rowsOf(h.client, first.dataset.id),
      before,
      "the earlier version is unchanged",
    );
    assert.ok((await turnIdsOf(h.client, first.dataset.id)).includes(turn.s2[0]!));

    // RC-1177: with the scorers off, the run that fails a scorer is kept; the exclusion and the pin act as before.
    const off = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      { ...settings, scorers: "off" },
      "user_1",
      h.deps(),
    );
    assert.ok(off.ok);
    assert.equal(off.dataset.settings.scorers, "off");
    assert.ok((await runDatasetBuild(PROJECT_A, { datasetId: off.dataset.id }, h.deps())).built);
    const offTurns = new Set(await turnIdsOf(h.client, off.dataset.id));
    assert.equal(
      offTurns.has(turn.s1[1]!),
      true,
      "a run that fails a scorer is kept with the scorers off",
    );
    assert.equal(offTurns.has(turn.s2[0]!), false, "the excluded run stays out");
    assert.equal(offTurns.size, 5);
    const offDataset = (await createDrizzleDatasetStore(h.db).getDataset(
      PROJECT_A,
      off.dataset.id,
    ))!;
    assert.equal(offDataset.counts!.dropped.user_scorer_failed, 0);
    assert.deepEqual(offDataset.counts!.scorerDrops, { runs: 0, calls: 0, byKind: {} });

    // RC-1177: a version stored before it, with no scorers setting and no scorer drops, loads as scorers on with an empty breakdown.
    await h.client.query(
      "update fine_tuning_datasets set settings = settings - 'scorers', counts = counts - 'scorerDrops' where id = $1",
      [second.dataset.id],
    );
    const legacy = (await createDrizzleDatasetStore(h.db).getDataset(
      PROJECT_A,
      second.dataset.id,
    ))!;
    assert.equal(legacy.settings.scorers, "on");
    assert.deepEqual(viewOfDataset(legacy).counts?.scorerDrops, { runs: 0, calls: 0, byKind: {} });

    // Cleared, the exclusion no longer applies; an exclusion keeps its first time while it stands.
    const cleared = await overrides.setOverride(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      { turnId: turn.s2[0]!, excluded: false },
      "user_1",
    );
    assert.ok(cleared.ok && !cleared.override.excluded);
  } finally {
    await h.client.close();
  }
});

test("RC-1130: the rows route pages in ordinal order and filters by side; project B cannot read rows or set overrides of project A", async () => {
  const h = await seeded();
  try {
    // Turn 1's group (turns 1 to 3) goes to eval whole; with evalFraction 0 the other group is train.
    await h.client.query(
      "insert into task_eval_sets (project_id, task_id, scorer_version) values ($1, 'triage', 1)",
      [PROJECT_A],
    );
    await h.client.query(
      "insert into task_eval_cases (project_id, task_id, turn_id, origin) values ($1, 'triage', $2, 'user')",
      [PROJECT_A, (await turnsBySession(h.client, PROJECT_A)).s1[0]!],
    );
    const started = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      { dedup: "off", evalFraction: 0 },
      "user_1",
      h.deps(),
    );
    assert.ok(started.ok);
    assert.ok(
      (await runDatasetBuild(PROJECT_A, { datasetId: started.dataset.id }, h.deps())).built,
    );
    const stored = await rowsOf(h.client, started.dataset.id);
    const events: OverrideEvent[] = [];
    const deps = (projectId: string): ReviewApiDeps => ({
      getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
      findProjectScope: async (id) =>
        id === projectId
          ? {
              project: { id } as Project,
              organization: { id: ORGANIZATION_ID } as Organization,
              role: "member",
            }
          : null,
      fineTuningEnabled: async () => true,
      isRestricted: async () => false,
      datasets: () => createDrizzleDatasetStore(h.db),
      overrides: () => createDrizzleOverrideStore(h.db),
      track: async (event) => void events.push(event),
    });
    const rowsUrl = (query: string) => new Request(`http://test/rows?${query}`);
    const page = async (projectId: string, query: string) => {
      const response = await handleDatasetRowsRequest(
        rowsUrl(query),
        projectId,
        started.dataset.id,
        deps(projectId),
      );
      return {
        status: response.status,
        body: (await response.json()) as {
          rows: { ordinal: number; side: string; content: unknown }[];
          nextCursor: string | null;
        },
      };
    };

    const ordinals: number[] = [];
    let cursor: string | null = null;
    do {
      const { status, body } = await page(PROJECT_A, `limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(status, 200);
      ordinals.push(...body.rows.map((row) => row.ordinal));
      cursor = body.nextCursor;
    } while (cursor);
    assert.deepEqual(
      ordinals,
      stored.map((row) => row.ordinal),
    );

    const evalRows = await page(PROJECT_A, "side=eval");
    assert.deepEqual(
      evalRows.body.rows.map((row) => row.ordinal),
      stored.filter((row) => row.side === "eval").map((row) => row.ordinal),
    );
    assert.ok(
      evalRows.body.rows.length === 3 &&
        evalRows.body.rows.every((row) => row.side === "eval" && row.content !== null),
    );
    assert.equal((await page(PROJECT_A, "side=both")).status, 400);

    // Project B: A's dataset is not found, by the route and by the store.
    assert.equal((await page(PROJECT_B, "")).status, 404);
    assert.deepEqual(
      await createDrizzleDatasetStore(h.db).listRows(PROJECT_B, started.dataset.id, {
        side: null,
        after: null,
        limit: 10,
      }),
      [],
    );

    const turnA = (await turnsBySession(h.client, PROJECT_A)).s1[0]!;
    const turnB = (await turnsBySession(h.client, PROJECT_B)).b1[0]!;
    const put = (projectId: string, useCaseId: string, body: unknown) =>
      handleOverridesRequest(
        new Request("http://test/overrides", { method: "PUT", body: JSON.stringify(body) }),
        projectId,
        useCaseId,
        deps(projectId),
      );
    assert.equal(
      (await put(PROJECT_B, h.useCases[PROJECT_A]!, { turnId: turnA, excluded: true })).status,
      404,
      "B cannot change A's use case",
    );
    assert.equal(
      (await put(PROJECT_A, h.useCases[PROJECT_A]!, { turnId: turnB, excluded: true })).status,
      404,
      "A cannot name B's run",
    );
    assert.equal((await put(PROJECT_A, h.useCases[PROJECT_A]!, { turnId: turnA })).status, 400);
    assert.equal(await count(h.client, "fine_tuning_use_case_overrides"), 0);
    assert.equal(events.length, 0);

    const ok = await put(PROJECT_A, h.useCases[PROJECT_A]!, {
      turnId: turnA,
      excluded: true,
      pinned: true,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(
      events.map((event) => `${event.name}:${event.value}`),
      ["dataset_row_excluded:true", "dataset_row_pinned:true"],
    );
    const marked = (await page(PROJECT_A, "limit=100")).body.rows as {
      turnId?: string;
      excluded?: boolean;
    }[];
    assert.ok(marked.filter((row) => row.turnId === turnA).every((row) => row.excluded === true));
    assert.deepEqual(
      await rowsOf(h.client, started.dataset.id),
      stored,
      "an override changes no stored row",
    );
  } finally {
    await h.client.close();
  }
});

/** The project's turn ids by session, in trace order. */
async function turnsBySession(
  client: PGlite,
  projectId: string,
): Promise<Record<string, string[]>> {
  const { rows } = await client.query<{ id: string; session_id: string }>(
    "select id, session_id from trace_turns where project_id = $1 order by started_at",
    [projectId],
  );
  const out: Record<string, string[]> = {};
  for (const row of rows) out[row.session_id] = [...(out[row.session_id] ?? []), row.id];
  return out;
}

async function turnIdsOf(client: PGlite, datasetId: string): Promise<string[]> {
  return (
    await client.query<{ turn_id: string }>(
      "select turn_id from fine_tuning_dataset_rows where dataset_id = $1 order by ordinal",
      [datasetId],
    )
  ).rows.map((row) => row.turn_id);
}

const PROJECT_E = "99999999-9999-4999-8999-999999999999";

test("RC-1131: the export streams each side in small pages; line counts are the stored counts minus the skipped ones, each line a chat example", async () => {
  const h = await seeded();
  try {
    // Project E: five turns of one call each; turn 3's reply is only a tool result, which the format cannot express.
    await h.client.query(
      `insert into projects (id, organization_id, name, slug) values ($1, $2, 'E', 'e')`,
      [PROJECT_E, ORGANIZATION_ID],
    );
    await h.client.query(
      `insert into fine_tuning_consents (project_id, given_by, text_version) values ($1, 'user_1', 'v1')`,
      [PROJECT_E],
    );
    const {
      rows: [useCase],
    } = await h.client.query<{ id: string }>(
      `insert into fine_tuning_use_cases (project_id, name, selector, created_by) values ($1, 'Triage', $2::jsonb, 'user_1') returning id`,
      [PROJECT_E, JSON.stringify({ taskIds: ["triage"], intentIds: [] })],
    );
    for (let i = 0; i < 5; i += 1) {
      const output =
        i === 2
          ? [{ role: "tool", tool_call_id: "c1", content: "done" }]
          : [{ role: "assistant", content: `answer ${i}` }];
      await seedCall(h, PROJECT_E, 20 + i, `e${i}`, {
        system: "Be brief.",
        messages: [{ role: "user", content: `question ${i}` }],
        output,
      });
    }
    await h.client.query(
      "insert into task_eval_sets (project_id, task_id, scorer_version) values ($1, 'triage', 1)",
      [PROJECT_E],
    );
    const firstTurn = (await turnsBySession(h.client, PROJECT_E)).e0![0]!;
    await h.client.query(
      "insert into task_eval_cases (project_id, task_id, turn_id, origin) values ($1, 'triage', $2, 'user')",
      [PROJECT_E, firstTurn],
    );

    const started = await startDatasetBuild(
      PROJECT_E,
      useCase!.id,
      { dedup: "off", evalFraction: 0 },
      "user_1",
      h.deps(),
    );
    assert.ok(started.ok);
    assert.ok(
      (await runDatasetBuild(PROJECT_E, { datasetId: started.dataset.id }, h.deps())).built,
    );
    const dataset = (await createDrizzleDatasetStore(h.db).getDataset(
      PROJECT_E,
      started.dataset.id,
    ))!;
    assert.deepEqual(
      { train: dataset.counts!.train, eval: dataset.counts!.eval },
      { train: 4, eval: 1 },
    );
    assert.deepEqual(dataset.counts!.exportSkipped, { train: 1, eval: 0 });

    const { deps, events } = exportDeps(h, PROJECT_E, { pageRows: 2 });
    for (const side of ["train", "eval"] as const) {
      const response = await handleDatasetExportRequest(
        new Request(`http://test/export?side=${side}`),
        PROJECT_E,
        dataset.id,
        deps,
      );
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-disposition") ?? "",
        new RegExp(`^attachment; filename=".*-v1-${side}\\.jsonl"$`),
      );
      const skipped = Number(response.headers.get(SKIPPED_HEADER));
      const lines = (await response.text()).split("\n").filter((line) => line.length > 0);
      assert.equal(lines.length, dataset.counts![side] - skipped, side);
      assert.equal(Number(response.headers.get(ROWS_HEADER)), lines.length);
      for (const line of lines) {
        const example = JSON.parse(line) as { messages: { role: string; content: string }[] };
        assert.ok(Array.isArray(example.messages));
        assert.equal(example.messages[0]?.role, "system");
        assert.equal(example.messages.at(-1)?.role, "assistant");
      }
    }
    assert.deepEqual(
      events.map((event) => event.name),
      ["dataset_exported", "dataset_exported"],
    );

    // A version without stored skipped counts (built before RC-1131) counts them in one pass.
    await h.client.query(
      "update fine_tuning_datasets set counts = counts - 'exportSkipped' - 'exportSkipReasons' where id = $1",
      [dataset.id],
    );
    const old = await handleDatasetExportRequest(
      new Request("http://test/export?side=train"),
      PROJECT_E,
      dataset.id,
      deps,
    );
    assert.equal(old.headers.get(SKIPPED_HEADER), "1");
    assert.equal((await old.text()).trim().split("\n").length, 3);

    // An API key, another project, a bad side.
    const keyed = new Request("http://test/export?side=train", {
      headers: { authorization: "Bearer rtl_test" },
    });
    assert.equal(
      (await handleDatasetExportRequest(keyed, PROJECT_E, dataset.id, deps)).status,
      403,
    );
    const asB = exportDeps(h, PROJECT_B).deps;
    assert.equal(
      (
        await handleDatasetExportRequest(
          new Request("http://test/export?side=train"),
          PROJECT_B,
          dataset.id,
          asB,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await handleDatasetExportRequest(
          new Request("http://test/export?side=both"),
          PROJECT_E,
          dataset.id,
          deps,
        )
      ).status,
      400,
    );
  } finally {
    await h.client.close();
  }
});

test("RC-1131: delete removes the dataset, its rows and its lineage link; a second delete and another project's delete are 404", async () => {
  const h = await seeded();
  try {
    const started = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      {},
      "user_1",
      h.deps(),
    );
    assert.ok(started.ok);
    assert.ok(
      (await runDatasetBuild(PROJECT_A, { datasetId: started.dataset.id }, h.deps())).built,
    );
    const links = async () =>
      (
        await h.client.query<{ n: number }>(
          "select count(*)::int as n from lineage_links where kind = 'dataset' and object_id = $1",
          [started.dataset.id],
        )
      ).rows[0]!.n;
    assert.equal(await links(), 1);

    assert.equal(
      (
        await handleDatasetDeleteRequest(
          PROJECT_B,
          started.dataset.id,
          exportDeps(h, PROJECT_B).deps,
        )
      ).status,
      404,
      "B cannot delete A's dataset",
    );
    assert.equal(await count(h.client, "fine_tuning_datasets"), 1);

    const { deps, events } = exportDeps(h, PROJECT_A);
    assert.equal(
      (await handleDatasetDeleteRequest(PROJECT_A, started.dataset.id, deps)).status,
      200,
    );
    assert.equal(await count(h.client, "fine_tuning_datasets"), 0);
    assert.equal(await count(h.client, "fine_tuning_dataset_rows"), 0);
    assert.equal(await links(), 0);
    assert.deepEqual(
      events.map((event) => event.name),
      ["dataset_deleted"],
    );
    assert.equal(
      (await handleDatasetDeleteRequest(PROJECT_A, started.dataset.id, deps)).status,
      404,
    );
  } finally {
    await h.client.close();
  }
});

function exportDeps(
  h: Harness,
  projectId: string,
  options: Partial<Pick<ExportApiDeps, "pageRows" | "fineTuningEnabled">> = {},
) {
  const events: DatasetLifecycleEvent[] = [];
  const deps: ExportApiDeps = {
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (id) =>
      id === projectId
        ? {
            project: { id } as Project,
            organization: { id: ORGANIZATION_ID } as Organization,
            role: "member",
          }
        : null,
    fineTuningEnabled: async () => true,
    isRestricted: async () => false,
    datasets: () => createDrizzleDatasetStore(h.db),
    track: async (event) => void events.push(event),
    ...options,
  };
  return { deps, events };
}

/** One closed turn of task `triage` with one call of this content. */
async function seedCall(
  h: Harness,
  projectId: string,
  index: number,
  session: string,
  content: Record<string, unknown>,
) {
  const minutes = index * 10;
  const start = new Date(T0 + minutes * 60_000).toISOString();
  const end = new Date(T0 + minutes * 60_000 + 30_000).toISOString();
  await h.client.query(
    `insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
     values ($1, $2, $3, 'otlp', 'otlp', 'closed', $4, $5, $5, 'triage')`,
    [projectId, session, `otlp:${traceId(index)}`, start, end],
  );
  await insertOtelSpans(projectId, [span(index * 10, projectId, index, minutes)], h.db as never);
  await h.client.query(
    `insert into events (project_id, occurred_at, model, cost_usd, trace_id, span_id, payload) values ($1, $2, 'claude-haiku', '0.001', $3, $4, $5::jsonb)`,
    [
      projectId,
      new Date(T0 + minutes * 60_000 + 1_000).toISOString(),
      traceId(index),
      spanId(index * 10 + 1),
      JSON.stringify({ provider: "anthropic", model: "claude-haiku", ts: start, ...content }),
    ],
  );
}

const PROJECT_F = "77777777-7777-4777-8777-777777777777";

test("RC-1176: a tool picker turn: each row carries the tools its history calls, a row with an undefined tool is skipped at export and counted, and a paged build has the same hash", async () => {
  const h = await seeded();
  try {
    await h.client.query(
      `insert into projects (id, organization_id, name, slug) values ($1, $2, 'F', 'f')`,
      [PROJECT_F, ORGANIZATION_ID],
    );
    await h.client.query(
      `insert into fine_tuning_consents (project_id, given_by, text_version) values ($1, 'user_1', 'v1')`,
      [PROJECT_F],
    );
    const {
      rows: [useCase],
    } = await h.client.query<{ id: string }>(
      `insert into fine_tuning_use_cases (project_id, name, selector, created_by) values ($1, 'Triage', $2::jsonb, 'user_1') returning id`,
      [PROJECT_F, JSON.stringify({ taskIds: ["triage"], intentIds: [] })],
    );
    const tool = (name: string) => ({
      name,
      description: `${name} tool`,
      parameters: { type: "object" },
    });
    const ask = { role: "user", content: "book me a flight" };
    const calls = (id: string, name: string) => ({
      role: "assistant",
      content: [{ type: "tool_call", id, name, arguments: {} }],
    });
    const result = (id: string) => ({ role: "tool", tool_call_id: id, content: "done" });
    const history2 = [ask, calls("c1", "search"), result("c1")];
    const history3 = [
      ...history2,
      calls("c2", "book"),
      result("c2"),
      calls("c3", "ghost"),
      result("c3"),
    ];
    await seedTurn(h, PROJECT_F, 30, "f1", [
      { tools: [tool("search"), tool("lookup")], messages: [ask], output: [calls("c1", "search")] },
      { tools: [tool("book")], messages: history2, output: [calls("c2", "book")] },
      {
        tools: [tool("refund")],
        messages: history3,
        output: [{ role: "assistant", content: "booked" }],
      },
    ]);

    const settings = { dedup: "off" as const, evalFraction: 0 };
    const whole = await startDatasetBuild(PROJECT_F, useCase!.id, settings, "user_1", h.deps());
    assert.ok(whole.ok);
    const wholeRun = await runDatasetBuild(PROJECT_F, { datasetId: whole.dataset.id }, h.deps());
    assert.ok(wholeRun.built);
    const stored = await rowsOf(h.client, whole.dataset.id);
    const names = stored.map((row) =>
      ((row.content as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name),
    );
    assert.deepEqual(names, [
      ["search", "lookup"],
      ["book", "search"],
      ["refund", "search", "book"],
    ]);

    const dataset = (await createDrizzleDatasetStore(h.db).getDataset(
      PROJECT_F,
      whole.dataset.id,
    ))!;
    assert.deepEqual(dataset.counts!.exportSkipped, { train: 1, eval: 0 });
    assert.equal(dataset.counts!.exportSkipReasons?.train.undefined_tool, 1);

    const { deps } = exportDeps(h, PROJECT_F);
    const response = await handleDatasetExportRequest(
      new Request("http://test/export?side=train"),
      PROJECT_F,
      dataset.id,
      deps,
    );
    assert.equal(response.headers.get(SKIPPED_HEADER), "1");
    assert.equal(response.headers.get(SKIPPED_REASONS_HEADER), "undefined_tool=1");
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            messages: { tool_calls?: { function: { name: string } }[] }[];
            tools?: { function: { name: string } }[];
          },
      );
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const defined = new Set((line.tools ?? []).map((t) => t.function.name));
      for (const message of line.messages)
        for (const call of message.tool_calls ?? [])
          assert.ok(defined.has(call.function.name), call.function.name);
    }

    const paged = await startDatasetBuild(PROJECT_F, useCase!.id, settings, "user_1", h.deps());
    assert.ok(paged.ok);
    const pagedDeps = h.deps({ pageCalls: 1, maxPagesPerRun: 1 });
    let hash: string | null = null;
    for (let i = 0; i < 5 && hash === null; i += 1) {
      const run = await runDatasetBuild(PROJECT_F, { datasetId: paged.dataset.id }, pagedDeps);
      if (run.built) hash = run.contentHash;
    }
    assert.equal(hash, wholeRun.contentHash);
  } finally {
    await h.client.close();
  }
});

/** One closed turn of task `triage` with one call per content, one second apart. */
async function seedTurn(
  h: Harness,
  projectId: string,
  index: number,
  session: string,
  contents: Record<string, unknown>[],
) {
  const minutes = index * 10;
  const start = new Date(T0 + minutes * 60_000).toISOString();
  const end = new Date(T0 + minutes * 60_000 + 30_000).toISOString();
  await h.client.query(
    `insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
     values ($1, $2, $3, 'otlp', 'otlp', 'closed', $4, $5, $5, 'triage')`,
    [projectId, session, `otlp:${traceId(index)}`, start, end],
  );
  await insertOtelSpans(projectId, [span(index * 10, projectId, index, minutes)], h.db as never);
  for (const [i, content] of contents.entries()) {
    await h.client.query(
      `insert into events (project_id, occurred_at, model, cost_usd, trace_id, span_id, payload) values ($1, $2, 'claude-haiku', '0.001', $3, $4, $5::jsonb)`,
      [
        projectId,
        new Date(T0 + minutes * 60_000 + (i + 1) * 1_000).toISOString(),
        traceId(index),
        spanId(index * 10 + 1 + i),
        JSON.stringify({ provider: "anthropic", model: "claude-haiku", ts: start, ...content }),
      ],
    );
  }
}

test("RC-1178: GET reads one version's view without row text; another project's version and an unknown id are 404; flag off is 404; a read tracks nothing", async () => {
  const h = await seeded();
  try {
    const started = await startDatasetBuild(
      PROJECT_A,
      h.useCases[PROJECT_A]!,
      { scorers: "off" },
      "user_1",
      h.deps(),
    );
    assert.ok(started.ok);
    assert.ok(
      (await runDatasetBuild(PROJECT_A, { datasetId: started.dataset.id }, h.deps())).built,
    );
    const dataset = (await createDrizzleDatasetStore(h.db).getDataset(
      PROJECT_A,
      started.dataset.id,
    ))!;

    const { deps, events } = exportDeps(h, PROJECT_A);
    const response = await handleDatasetGetRequest(PROJECT_A, dataset.id, deps);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; dataset: Record<string, unknown> };
    assert.deepEqual(body, {
      ok: true,
      dataset: JSON.parse(JSON.stringify(viewOfDataset(dataset))),
    });
    assert.equal((body.dataset.settings as { scorers: string }).scorers, "off");
    assert.equal(body.dataset.status, "ready");
    const text = JSON.stringify(body);
    assert.equal(text.includes('"role"'), false, "no message of a row");
    assert.equal(text.includes("refund order"), false, "no row text");

    assert.equal(
      (await handleDatasetGetRequest(PROJECT_A, "00000000-0000-4000-8000-000000000000", deps))
        .status,
      404,
      "unknown id",
    );
    assert.equal(
      (await handleDatasetGetRequest(PROJECT_A, "not-a-uuid", deps)).status,
      404,
      "malformed id",
    );
    const asB = exportDeps(h, PROJECT_B).deps;
    const other = await handleDatasetGetRequest(PROJECT_B, dataset.id, asB);
    assert.equal(other.status, 404, "B cannot read A's dataset");
    assert.deepEqual(await other.json(), {
      ok: false,
      error: "dataset_not_found",
      message: "This project has no dataset with that ID.",
    });
    const off = exportDeps(h, PROJECT_A, { fineTuningEnabled: async () => false }).deps;
    assert.equal(
      (await handleDatasetGetRequest(PROJECT_A, dataset.id, off)).status,
      404,
      "flag off",
    );
    assert.deepEqual(events, [], "a read emits no business event");
  } finally {
    await h.client.close();
  }
});
