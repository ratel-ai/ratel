import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  decodeSessionsCursor,
  listSessions,
  runPageQuery,
  type SessionRow,
  type SessionsDb,
  sessionPageQuery,
} from "./sessions";

/**
 * RC-311: the Sessions list on a seeded project. Activity, newest first:
 * run 5 (no turn, failed root), session-c (clean), run 4 (its turn is still
 * open, so it is its own row), session-a (two turns, the second failed a tool
 * call), session-b (runtime lane, an error step), run 6 (no turn, clean).
 * Another project's session and run are newer than all of them and must never show.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const T0 = Date.parse("2026-11-02T09:00:00.000Z");
const NEWEST_FIRST = ["run:5", "session-c", "run:4", "session-a", "session-b", "run:6"];

type TestDb = SessionsDb & NonNullable<Parameters<typeof insertOtelSpans>[2]>;

test("listSessions pages every session and run once, newest first", async () => {
  const { client, db } = await seeded();
  try {
    const seen: SessionRow[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listSessions(PROJECT_ID, { filter: "all", cursor, limit: 2 }, db);
      assert.ok(page.items.length <= 2);
      seen.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    assert.deepEqual(seen.map(label), NEWEST_FIRST);
    assert.equal(pages, 3);
  } finally {
    await client.close();
  }
});

test("listSessions reads each row's ask, turns, times, failed flag and link", async () => {
  const { client, db } = await seeded();
  try {
    const { items, nextCursor } = await listSessions(PROJECT_ID, { filter: "all" }, db);
    assert.equal(nextCursor, null);
    const byLabel = new Map(items.map((row) => [label(row), row]));
    const a = byLabel.get("session-a");
    assert.deepEqual(
      a && {
        kind: a.kind,
        ask: a.ask,
        turns: a.turns,
        failed: a.failed,
        startedAt: a.startedAt,
        lastActivityAt: a.lastActivityAt,
        durationMs: a.durationMs,
        href: a.href,
        traceIds: a.traceIds,
      },
      {
        kind: "session",
        ask: "Where is order 1234?",
        turns: 2,
        failed: true,
        startedAt: iso(0),
        lastActivityAt: iso(10_100),
        durationMs: 10_100,
        href: `/project/${PROJECT_ID}/sessions/session-a`,
        traceIds: [traceId(1), traceId(2)],
      },
    );
    assert.deepEqual(a?.tools, ["lookup_order", "refund"]);
    assert.ok(Math.abs((a?.costUsd ?? 0) - 0.02) < 1e-9);
    assert.equal(a?.tokens, 30);
    // Text off: no ask, the first turn's intent names it.
    assert.deepEqual(
      [
        byLabel.get("session-b")?.ask,
        byLabel.get("session-b")?.intent,
        byLabel.get("session-b")?.failed,
      ],
      [null, "Refunds", true],
    );
    assert.equal(byLabel.get("session-c")?.failed, false);
    const run = byLabel.get("run:6");
    assert.deepEqual(
      run && {
        kind: run.kind,
        sessionId: run.sessionId,
        ask: run.ask,
        turns: run.turns,
        failed: run.failed,
        durationMs: run.durationMs,
        href: run.href,
      },
      {
        kind: "run",
        sessionId: null,
        ask: "Cancel my order",
        turns: 1,
        failed: false,
        durationMs: 100,
        href: `/project/${PROJECT_ID}/traces/${traceId(6)}`,
      },
    );
    assert.equal(byLabel.get("run:5")?.failed, true);
  } finally {
    await client.close();
  }
});

test("listSessions under Failed returns only failed sessions and runs, paged", async () => {
  const { client, db } = await seeded();
  try {
    const first = await listSessions(PROJECT_ID, { filter: "failed", limit: 2 }, db);
    assert.deepEqual(first.items.map(label), ["run:5", "session-a"]);
    assert.ok(first.nextCursor);
    const second = await listSessions(
      PROJECT_ID,
      { filter: "failed", limit: 2, cursor: first.nextCursor },
      db,
    );
    assert.deepEqual(second.items.map(label), ["session-b"]);
    assert.equal(second.nextCursor, null);
  } finally {
    await client.close();
  }
});

test("listSessions never shows another project's sessions or runs", async () => {
  const { client, db } = await seeded();
  try {
    const all = await listSessions(PROJECT_ID, { filter: "all" }, db);
    assert.ok(!all.items.some((row) => row.id === "session-x" || row.id === traceId(7)));
    const other = await listSessions(OTHER_PROJECT_ID, { filter: "all" }, db);
    assert.deepEqual(
      other.items.map((row) => row.id),
      [traceId(7), "session-x"],
    );
    // session-x's trace id is trace 1 in the other project: its spans must not leak into it.
    assert.deepEqual(other.items[1]?.tools, ["secret"]);
  } finally {
    await client.close();
  }
});

test("a bad cursor reads as the first page", async () => {
  assert.equal(decodeSessionsCursor("not a cursor"), null);
  assert.equal(decodeSessionsCursor(null), null);
  const { client, db } = await seeded();
  try {
    const page = await listSessions(PROJECT_ID, { filter: "all", cursor: "garbage", limit: 1 }, db);
    assert.deepEqual(page.items.map(label), ["run:5"]);
  } finally {
    await client.close();
  }
});

test("a page query walks the activity index under a LIMIT, never the whole table", async () => {
  const { client, db } = await seeded();
  try {
    await client.exec("set enable_seqscan = off");
    const cursor = decodeSessionsCursor(
      (await listSessions(PROJECT_ID, { filter: "all", limit: 1 }, db)).nextCursor,
    );
    for (const filter of ["all", "failed"] as const) {
      const sessions = await explain(db, sessionPageQuery(PROJECT_ID, filter, cursor, 51));
      assert.match(sessions, /^Limit/, `${filter}: sessions plan starts with a Limit\n${sessions}`);
      assert.match(
        sessions,
        /Index (Only )?Scan Backward using trace_turns_closed_ended_idx/,
        `${filter}: sessions\n${sessions}`,
      );
      assert.match(
        sessions,
        /Index Cond: .*ended_at <=/,
        `${filter}: sessions range on the cursor\n${sessions}`,
      );
      const runs = await explain(db, runPageQuery(PROJECT_ID, filter, cursor, 51));
      assert.match(runs, /^Limit/, `${filter}: runs plan starts with a Limit\n${runs}`);
      assert.match(
        runs,
        /Index (Only )?Scan Backward using otel_spans_project_(roots_started|started_trace)_idx/,
        `${filter}: runs\n${runs}`,
      );
      assert.match(
        runs,
        /Index Cond: .*started_at <=/,
        `${filter}: runs range on the cursor\n${runs}`,
      );
    }
  } finally {
    await client.close();
  }
});

function label(row: SessionRow): string {
  return row.kind === "session" ? row.id : `run:${Number.parseInt(row.id.slice(1), 16)}`;
}

async function explain(db: TestDb, query: ReturnType<typeof sessionPageQuery>): Promise<string> {
  const result = (await db.execute(sql`explain ${query}`)) as unknown as {
    rows: { "QUERY PLAN": string }[];
  };
  return result.rows.map((row) => row["QUERY PLAN"].trim()).join("\n");
}

async function seeded(): Promise<{
  client: Awaited<ReturnType<typeof createMigratedPGlite>>;
  db: TestDb;
}> {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as TestDb;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  const ask = (content: string) => ({
    "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content }] }]),
  });
  await insertOtelSpans(
    PROJECT_ID,
    [
      // session-a, turn 1: clean, with its ask.
      span(10, { traceId: traceId(1), at: T0, costUsd: "0.01", inputTokens: 10, outputTokens: 5 }),
      span(11, {
        traceId: traceId(1),
        parentSpanId: spanId(10),
        spanClass: "llm_call",
        name: "chat",
        at: T0 + 1,
        attributes: ask("Where is order 1234?"),
      }),
      span(12, {
        traceId: traceId(1),
        parentSpanId: spanId(10),
        spanClass: "tool",
        name: "execute_tool lookup_order",
        at: T0 + 2,
      }),
      // session-a, turn 2: a tool call failed.
      span(20, {
        traceId: traceId(2),
        at: T0 + 10_000,
        costUsd: "0.01",
        inputTokens: 10,
        outputTokens: 5,
      }),
      span(21, {
        traceId: traceId(2),
        parentSpanId: spanId(20),
        spanClass: "tool",
        name: "execute_tool refund",
        at: T0 + 10_001,
        statusCode: 2,
      }),
      // session-c: clean.
      span(30, { traceId: traceId(3), at: T0 + 19_000 }),
      // run 4: its turn is still open.
      span(40, { traceId: traceId(4), at: T0 + 15_000 }),
      // run 5: no turn, ended in an error.
      span(50, { traceId: traceId(5), at: T0 + 30_000, statusCode: 2 }),
      // run 6: no turn, clean, with its ask; a second root later in the run is not a second row.
      span(60, { traceId: traceId(6), at: T0 + 1_000 }),
      span(61, {
        traceId: traceId(6),
        parentSpanId: spanId(60),
        spanClass: "llm_call",
        name: "chat",
        at: T0 + 1_001,
        attributes: ask("Cancel my order"),
      }),
      span(62, { traceId: traceId(6), at: T0 + 1_050 }),
    ],
    db,
  );
  await insertOtelSpans(
    OTHER_PROJECT_ID,
    [
      span(90, { projectId: OTHER_PROJECT_ID, traceId: traceId(1), at: T0 + 40_000 }),
      span(91, {
        projectId: OTHER_PROJECT_ID,
        traceId: traceId(1),
        parentSpanId: spanId(90),
        spanClass: "tool",
        name: "execute_tool secret",
        at: T0 + 40_001,
        statusCode: 2,
      }),
      span(92, { projectId: OTHER_PROJECT_ID, traceId: traceId(7), at: T0 + 50_000 }),
    ],
    db,
  );

  const turn = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
  const row = (
    id: number,
    project: string,
    session: string,
    key: string,
    lane: string,
    status: string,
    start: number,
    end: number,
    errors = 0,
  ) =>
    `('${turn(id)}', '${project}', '${session}', '${key}', '${lane === "otlp" ? "otlp" : "declared"}', '${lane}', '${status}', '${iso(start)}', '${iso(end)}', '${iso(end)}', ${errors})`;
  await client.exec(`
    insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, error_count) values
      ${[
        row(1, PROJECT_ID, "session-a", `otlp:${traceId(1)}`, "otlp", "closed", 0, 100),
        row(2, PROJECT_ID, "session-a", `otlp:${traceId(2)}`, "otlp", "closed", 10_000, 10_100),
        row(3, PROJECT_ID, "session-b", "declared:b1", "runtime", "closed", 4_000, 5_000, 1),
        row(4, PROJECT_ID, "session-c", `otlp:${traceId(3)}`, "otlp", "closed", 19_000, 20_000),
        row(5, PROJECT_ID, "session-open", `otlp:${traceId(4)}`, "otlp", "open", 15_000, 15_100),
        row(
          9,
          OTHER_PROJECT_ID,
          "session-x",
          `otlp:${traceId(1)}`,
          "otlp",
          "closed",
          40_000,
          45_000,
        ),
      ].join(",\n      ")};
    insert into trace_topics (project_id, topic_id, name, input_hash) values ('${PROJECT_ID}', 't-refunds', 'Refunds', 'h2');
    insert into trace_turn_topics (turn_id, project_id, topic_id, verdict, started_at) values ('${turn(3)}', '${PROJECT_ID}', 't-refunds', 'topic', '${iso(4_000)}');
  `);
  return { client, db };
}

function iso(offset: number): string {
  return new Date(T0 + offset).toISOString();
}

function span(index: number, overrides: Partial<NewOtelSpan> & { at: number }): NewOtelSpan {
  const { at, ...rest } = overrides;
  return {
    id: `00000000-0000-8000-8000-${index.toString(16).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    traceId: traceId(index),
    spanId: spanId(index),
    parentSpanId: null,
    name: "invoke_agent support-agent",
    kind: 1,
    spanClass: "other",
    startedAt: new Date(at),
    endedAt: new Date(at + 100),
    durationMs: 100,
    statusCode: 1,
    serviceName: "fixture-agent",
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
    ...rest,
  };
}

function spanId(value: number): string {
  return value.toString(16).padStart(16, "0");
}

function traceId(value: number): string {
  return `a${value.toString(16).padStart(31, "0")}`;
}
