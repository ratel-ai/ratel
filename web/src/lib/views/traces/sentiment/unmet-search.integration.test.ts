import assert from "node:assert/strict";
import { test } from "node:test";
import { asc } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { fresh } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { loadAfterSearch } from "@/lib/views/traces/after-search";
import { loadRootCauses } from "@/lib/views/traces/sentiment/page-load";
import { DEFAULT_SENTIMENT_QUERY } from "@/lib/views/traces/sentiment/page-paths";
import { loadUnmetSearches, unmetSearchView } from "@/lib/views/traces/sentiment/unmet-search";
import { loadTurnDetail } from "@/lib/views/traces/turn-detail";

const NOW = new Date("2026-09-02T00:00:00Z");
const BASE = Date.parse("2026-09-01T09:00:00Z");

async function seeded() {
  const { client, db } = await setupDb();
  const later = fresh({ session: "later", start: BASE }).search(["create_task"], {
    query: "delete task",
  });
  await seedLedger(client, db, [
    fresh({ session: "unfit", start: BASE }).search(["create_task", "get_task"], {
      query: "delete task",
    }),
    later,
    fresh({ after: later, gapMs: 7_200_000 }).invoke("get_task").invoke("create_task"),
  ]);
  const turns = await db
    .select({ id: traceTurns.id, sessionId: traceTurns.sessionId })
    .from(traceTurns)
    .orderBy(asc(traceTurns.startedAt));
  const turnOf = (session: string) => turns.find((turn) => turn.sessionId === session)!.id;
  return { client, db, turnOf };
}

test("a search no tool fits reads as what was searched, offered and missing; other searches do not", async () => {
  const { client, db, turnOf } = await seeded();
  const searches = await loadUnmetSearches(PROJECT_ID, [turnOf("unfit"), turnOf("later")], db);
  assert.deepEqual(
    [...searches],
    [
      [
        turnOf("unfit"),
        {
          query: "delete task",
          offered: ["create_task", "get_task"],
          more: 0,
          missing: "none of them deletes anything",
        },
      ],
    ],
  );
  assert.equal((await loadUnmetSearches(PROJECT_ID, [], db)).size, 0);
  await client.close();
});

test("Root cause analysis shows it on the examples of No fitting tool", async () => {
  const { client, db, turnOf } = await seeded();
  const result = await computeProjectTraceSignals(
    PROJECT_ID,
    { trigger: "manual" },
    jobDeps(db, NOW),
  );
  assert.equal(result.outcome, "completed");
  const model = await loadRootCauses({
    projectId: PROJECT_ID,
    windowDays: 30,
    query: DEFAULT_SENTIMENT_QUERY,
    now: NOW,
    db,
    modelConfigured: false,
    minSessions: 1,
  });
  const rows = model.overview.groups.flatMap((group) =>
    group.rows.map((row) => [group.reason, row.cause, row.examples] as const),
  );
  assert.deepEqual(
    rows.map(([reason, cause, examples]) => [
      reason,
      cause,
      examples.map((example) => [example.turnId, example.search?.query]),
    ]),
    [["no_tool", "missing_capability", [[turnOf("unfit"), "delete task"]]]],
  );
  await client.close();
});

test("a turn that ended on a search says what the session ran next", async () => {
  const { client, db, turnOf } = await seeded();
  const next = async (session: string) => {
    const turn = await loadTurnDetail(PROJECT_ID, turnOf(session), db);
    return loadAfterSearch(db, PROJECT_ID, turn!);
  };
  assert.deepEqual(await next("unfit"), { ordinal: 1, next: null, listed: null });
  // The next call is not one the search listed; a later one is.
  const after = await next("later");
  assert.deepEqual([after?.next?.id, after?.listed?.id], ["get_task", "create_task"]);
  assert.ok(after!.next!.afterMs >= 7_200_000);
  assert.ok(after!.listed!.afterMs > after!.next!.afterMs);
  await client.close();
});

test("a turn that ended on a call says nothing of a search", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, [fresh({ session: "ran" }).search(["a"]).invoke("a")]);
  const [turn] = await db.select({ id: traceTurns.id }).from(traceTurns);
  const detail = await loadTurnDetail(PROJECT_ID, turn!.id, db);
  assert.equal(await loadAfterSearch(db, PROJECT_ID, detail!), null);
  await client.close();
});

test("what is missing is said for one tool, for several, and for none; a long list is cut", () => {
  const search = { ordinal: 1, eventIds: ["e"], query: null };
  assert.equal(
    unmetSearchView({ ...search, wanted: null, offered: [] }).missing,
    "the search returned no tool",
  );
  assert.equal(
    unmetSearchView({ ...search, wanted: "read", offered: ["a"] }).missing,
    "it does not look anything up",
  );
  const long = unmetSearchView({
    ...search,
    wanted: "create",
    offered: ["a", "b", "c", "d", "e", "f", "g"],
  });
  assert.deepEqual([long.offered.length, long.more], [5, 2]);
});
