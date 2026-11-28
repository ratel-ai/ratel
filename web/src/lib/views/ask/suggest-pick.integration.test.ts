import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { QUERY_VERSION } from "@/lib/contracts/query";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { RQL_VERSION } from "@/lib/synthesis/rql/compile";
import { createDashboard } from "@/lib/views/dashboards/store";
import { draftWidgets } from "./draft";
import { ASK_MODEL } from "./limits";
import { setAskOutcome } from "./store";
import {
  loadSuggestInput,
  loadSuggestions,
  SuggestCache,
  type SuggestEngine,
  type SuggestQuestion,
} from "./suggest-pick";

const ORG = "22222222-2222-4222-8222-222222222222";
const A = "11111111-1111-4111-8111-111111111111";
const B = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-24T12:00:00Z");
const TARGET = { target: "dashboard" as const, dashboardId: null };

let client: PGlite;
let db: ReturnType<typeof getDb>;

beforeEach(async () => {
  client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${A}', '${ORG}', 'A', 'a'), ('${B}', '${ORG}', 'B', 'b');
    insert into trace_property_keys (project_id, name, state, source, seen_count) values
      ('${A}', 'a_only_plan', 'indexed', 'user', 5);
  `);
  for (const project of [A, B])
    await client.query(
      `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
         input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at, end_user_id)
       values ($1, $2, $3, 100, false, 1, 1, 0, $3, $3, 'end-user')`,
      [project, project.slice(0, 8).padEnd(32, "0"), NOW],
    );
  db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
});

/** An engine that ranks the option whose text matches `prefer` first, and keeps each question. */
function engine(prefer: RegExp, delayMs = 0): SuggestEngine & { questions: SuggestQuestion[] } {
  const questions: SuggestQuestion[] = [];
  return {
    questions,
    async rank(question) {
      questions.push(question);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return Object.fromEntries(
        question.options.map(({ id, does }) => [id, prefer.test(does) ? 0.9 : 0.01]),
      );
    },
  };
}

test("the decision model picks among the candidates; no engine gives the fixed order", async () => {
  const fixed = await loadSuggestions(A, TARGET, { engine: null, db });
  assert.equal(fixed.source, "fixed");
  assert.equal(fixed.prompts.length, 4);
  const picker = engine(/end users/);
  const picked = await loadSuggestions(A, TARGET, {
    engine: picker,
    db,
    cache: new SuggestCache(),
  });
  assert.equal(picked.source, "model");
  assert.equal(picked.prompts[0], "Show which end users spend the most");
  assert.equal(picked.prompts.length, 4);
  assert.equal(picker.questions.length, 1, "one question picks all four");
});

test("an engine error or a refusal gives the fixed order", async () => {
  const fixed = await loadSuggestions(A, TARGET, { engine: null, db });
  const failing: SuggestEngine = {
    async rank() {
      throw new Error("down");
    },
  };
  const refusing: SuggestEngine = { rank: async () => null };
  for (const broken of [failing, refusing])
    assert.deepEqual(
      await loadSuggestions(A, TARGET, { engine: broken, db, cache: new SuggestCache() }),
      fixed,
    );
});

test("a slow engine gives the fixed order first, and its pick on the next open", async () => {
  const cache = new SuggestCache();
  const slow = engine(/end users/, 80);
  const first = await loadSuggestions(A, TARGET, { engine: slow, db, cache, waitMs: 5 });
  assert.equal(first.source, "fixed");
  await new Promise((resolve) => setTimeout(resolve, 120));
  const next = await loadSuggestions(A, TARGET, { engine: slow, db, cache, waitMs: 5 });
  assert.equal(next.source, "model");
  assert.equal(next.prompts[0], "Show which end users spend the most");
  assert.equal(slow.questions.length, 1, "the cached pick is reused");
});

test("project A's dashboards, properties and asks give nothing to project B", async () => {
  await createDashboard(
    {
      projectId: A,
      name: "A costs",
      widgets: [
        {
          id: crypto.randomUUID(),
          title: "A cost",
          query: {
            version: QUERY_VERSION,
            kind: "sql",
            text: "select time_bucket('1 day', started_at) as day, sum(cost_usd) as cost from traces group by day",
            rqlVersion: RQL_VERSION,
          },
          chart: "line",
          layout: { x: 0, y: 0, w: 6, h: 4 },
        },
      ],
      updatedBy: "u",
      updatedByName: null,
    },
    db,
  );
  const model = {
    model: ASK_MODEL,
    standIn: false,
    complete: async () => ({
      text: JSON.stringify({
        widgets: [{ title: "Users", rql: "select user_id, cost_usd from users", chart: "table" }],
      }),
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };
  const drafted = await draftWidgets(
    {
      projectId: A,
      actor: "u",
      surface: "console",
      target: "dashboard",
      dashboardId: null,
      words: "my top end users",
    },
    { model, db: db as never, now: () => NOW },
  );
  assert.equal(drafted.status, "drafted");
  if (drafted.status !== "drafted") return;
  await setAskOutcome(A, drafted.askId, "kept", NOW, db);

  const a = await loadSuggestInput(A, TARGET, db);
  assert.equal(a.dashboards.length, 1);
  assert.deepEqual(a.properties, ["a_only_plan"]);
  assert.equal(a.earlierAsks.length, 1);

  const b = await loadSuggestInput(B, TARGET, db);
  assert.deepEqual(b.dashboards, []);
  assert.deepEqual(b.properties, []);
  assert.deepEqual(b.earlierAsks, []);
  const picker = engine(/never/);
  await loadSuggestions(B, TARGET, { engine: picker, db, cache: new SuggestCache() });
  const asked = JSON.stringify(picker.questions);
  for (const absent of ["a_only_plan", "A costs", "A cost", "my top end users"])
    assert.ok(!asked.includes(absent), `B's question holds ${absent}`);

  // The kept ask of A reaches A's next suggestion: its topic comes first.
  const next = await loadSuggestions(A, TARGET, { engine: null, db });
  assert.equal(next.prompts[0], "Show which end users spend the most");
  assert.notEqual(
    (await loadSuggestions(B, TARGET, { engine: null, db })).prompts[0],
    "Show which end users spend the most",
  );
});

test("a pick is kept per title of the new dashboard", async () => {
  const cache = new SuggestCache();
  const picker = engine(/end users/);
  for (const title of ["Costs", "Errors", "Costs"])
    await loadSuggestions(A, { ...TARGET, title }, { engine: picker, db, cache });
  assert.equal(picker.questions.length, 2, "one question per title, the repeat from the cache");
  assert.match(picker.questions[1]?.instructions ?? "", /"Errors"/);
});
