import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { parseTraceEvents } from "./parse";
import {
  insertTraceEvents,
  listSearchQueriesForSkillHit,
  listSkillsSearchedButNeverInvoked,
  listTopErroringTools,
  listTopSearchQueries,
} from "./queries";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const DAY = 86_400_000;
const BASE = Date.parse("2026-06-27T00:00:00Z");

type Db = Parameters<typeof insertTraceEvents>[2] &
  Parameters<typeof listTopSearchQueries>[2] &
  Parameters<typeof listSkillsSearchedButNeverInvoked>[2];

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG_ID}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug) values
       ('${PROJECT_ID}', '${ORG_ID}', 'P', 'p'),
       ('${OTHER_PROJECT_ID}', '${ORG_ID}', 'O', 'o');`,
  );
  return drizzle(client) as unknown as Db;
}

function ev(body: Record<string, unknown>, daysAgo = 1): Record<string, unknown> {
  return { v: 1, ts: BASE - daysAgo * DAY, session_id: "sess-1", ...body };
}

async function ingest(db: Db, projectId: string, events: Record<string, unknown>[]) {
  const { valid, rejected } = parseTraceEvents(events);
  assert.equal(rejected.length, 0);
  await insertTraceEvents(projectId, valid, db);
}

test("every search type counts, most asked first, and the window and project bound it", async () => {
  const db = await setup();
  await ingest(db, PROJECT_ID, [
    ev({ type: "search", query: "make a changelog", hits: [{ tool_id: "changelog.gen" }] }, 1),
    ev({ type: "skill_search", query: "make a changelog", hits: [{ skill_id: "changelog" }] }, 2),
    ev({ type: "search", query: "fix failing tests", hits: [{ tool_id: "test.run" }] }, 3),
    ev({ type: "search", query: "ancient query", hits: [{ tool_id: "old.tool" }] }, 30),
  ]);
  await ingest(db, OTHER_PROJECT_ID, [
    ev({ type: "search", query: "not ours", hits: [{ tool_id: "other.tool" }] }, 1),
  ]);

  const rows = await listTopSearchQueries(PROJECT_ID, { since: new Date(BASE - 7 * DAY) }, db);

  assert.deepEqual(rows, [
    { query: "make a changelog", searches: 2 },
    { query: "fix failing tests", searches: 1 },
  ]);
});

test("the limit keeps the most asked and an end user narrows the count", async () => {
  const db = await setup();
  await ingest(db, PROJECT_ID, [
    ev({ type: "search", query: "first", end_user_id: "u-ada", hits: [{ tool_id: "a" }] }),
    ev({ type: "search", query: "first", hits: [{ tool_id: "a" }] }, 2),
    ev({ type: "search", query: "second", hits: [{ tool_id: "b" }] }),
  ]);
  const since = new Date(BASE - 7 * DAY);

  assert.deepEqual(await listTopSearchQueries(PROJECT_ID, { since, limit: 1 }, db), [
    { query: "first", searches: 2 },
  ]);
  assert.deepEqual(await listTopSearchQueries(PROJECT_ID, { since, endUserId: "u-ada" }, db), [
    { query: "first", searches: 1 },
  ]);
});

/** The synthetic usage batch upstream's demo asserts the three example questions against. */
function demoBatch(): Record<string, unknown>[] {
  return [
    // Searches surface three skills; only write-changelog is later invoked.
    ev(
      {
        type: "skill_search",
        query: "make a changelog",
        hits: [
          { skill_id: "write-changelog", score: 0.9 },
          { skill_id: "summarize-pr", score: 0.5 },
        ],
      },
      1,
    ),
    ev(
      {
        type: "skill_search",
        query: "make a changelog",
        hits: [
          { skill_id: "write-changelog", score: 0.9 },
          { skill_id: "orphan-skill", score: 0.2 },
        ],
      },
      2,
    ),
    ev({ type: "skill_invoke", skill_id: "write-changelog" }, 1),
    // Tool errors across the three error variants.
    ev({ type: "invoke_error", tool_id: "git.push", error: "auth failed" }, 1),
    ev({ type: "gateway_error", tool_id: "git.push", error: "timeout" }, 2),
    ev({ type: "upstream_error", server: "gh", tool_id: "git.push", error: "429" }, 2),
    ev({ type: "invoke_error", tool_id: "npm.install", error: "ENOENT" }, 1),
    // Tool searches for the "top queries this week" question.
    ev({ type: "search", query: "make a changelog", hits: [{ tool_id: "changelog.gen" }] }, 1),
    ev({ type: "search", query: "fix failing tests", hits: [{ tool_id: "test.run" }] }, 3),
    // An old search that must fall outside a 7-day window.
    ev({ type: "search", query: "ancient query", hits: [{ tool_id: "old.tool" }] }, 30),
  ];
}

test("demo: skills searched-for but never invoked", async () => {
  const db = await setup();
  await ingest(db, PROJECT_ID, demoBatch());

  const rows = await listSkillsSearchedButNeverInvoked(PROJECT_ID, {}, db);
  const skills = rows.map((r) => r.skillId).sort();
  // write-changelog was invoked → excluded; the other two were only ever surfaced.
  assert.deepEqual(skills, ["orphan-skill", "summarize-pr"]);
  // summarize-pr appeared in one search, orphan-skill in one.
  const byId = Object.fromEntries(rows.map((r) => [r.skillId, Number(r.searchAppearances)]));
  assert.equal(byId["summarize-pr"], 1);
  assert.equal(byId["orphan-skill"], 1);
});

test("demo: tools erroring most", async () => {
  const db = await setup();
  await ingest(db, PROJECT_ID, demoBatch());

  const rows = await listTopErroringTools(PROJECT_ID, {}, db);
  assert.deepEqual(
    rows.map((r) => ({ toolId: r.toolId, errors: Number(r.errors) })),
    [
      { toolId: "git.push", errors: 3 }, // invoke + gateway + upstream
      { toolId: "npm.install", errors: 1 },
    ],
  );
});

test("the queries that surfaced a skill come most frequent first, limited, and narrowed to an end user", async () => {
  const db = await setup();
  await ingest(db, PROJECT_ID, [
    ev({ type: "skill_search", query: "refund me", hits: [{ skill_id: "refund-policy" }] }, 1),
    ev(
      {
        type: "skill_search",
        query: "refund me",
        end_user_id: "u-ada",
        hits: [{ skill_id: "refund-policy" }],
      },
      2,
    ),
    ev(
      { type: "skill_search", query: "cancel my order", hits: [{ skill_id: "refund-policy" }] },
      1,
    ),
    ev({ type: "skill_search", query: "track my package", hits: [{ skill_id: "shipping" }] }, 1),
  ]);
  await ingest(db, OTHER_PROJECT_ID, [
    ev({ type: "skill_search", query: "not ours", hits: [{ skill_id: "refund-policy" }] }, 1),
  ]);

  assert.deepEqual(await listSearchQueriesForSkillHit(PROJECT_ID, "refund-policy", 8, {}, db), [
    "refund me",
    "cancel my order",
  ]);
  assert.deepEqual(await listSearchQueriesForSkillHit(PROJECT_ID, "refund-policy", 1, {}, db), [
    "refund me",
  ]);
  assert.deepEqual(
    await listSearchQueriesForSkillHit(PROJECT_ID, "refund-policy", 8, { endUserId: "u-ada" }, db),
    ["refund me"],
  );
});
