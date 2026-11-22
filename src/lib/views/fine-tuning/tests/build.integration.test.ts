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
import { sourceOf } from "@/lib/views/lineage/resolve";
import { createDrizzleDatasetStore } from "../adapters/drizzle-dataset-store";
import {
  type BuildJobPayload,
  type DatasetBuildDeps,
  type DatasetEvent,
  runDatasetBuild,
  startDatasetBuild,
} from "../build";
import { datasetBuildDeps } from "../build-deps";

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
