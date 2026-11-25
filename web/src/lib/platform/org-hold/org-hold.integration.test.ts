import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { consoleClosed } from "./console";
import { type HoldsRouteDeps, handleHoldsGet, handleHoldsPost } from "./holds-route";
import { createHoldReader, HOLD_CACHE_MS, loadHolds, NO_HOLDS } from "./state";
import { clearHold, HOLD_SETTLE_MS, holdStatus, projectsOfScope, setHold } from "./store";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_ORG = "bbbbbbbb-0000-4000-8000-000000000001";
const A = "aaaaaaaa-0000-4000-8000-000000000002";
const A2 = "aaaaaaaa-0000-4000-8000-000000000003";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const VALUE = "s".repeat(44);

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme'), ('${OTHER_ORG}', 'Globex', 'globex');
    insert into projects (id, organization_id, name, slug) values
      ('${A}', '${ORG}', 'One', 'one'), ('${A2}', '${ORG}', 'Two', 'two'), ('${B}', '${OTHER_ORG}', 'One', 'one');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof getDb> };
}

test("the route sets, reads and clears a hold, and clearing starts the jobs", async () => {
  const { db } = await setup();
  const started: string[] = [];
  const deps: HoldsRouteDeps = {
    config: { internal: { secret: VALUE } },
    isDbConfigured: () => true,
    organizationExists: async (id) => id === ORG || id === OTHER_ORG,
    projectsOfScope: (scope) => projectsOfScope(scope, db),
    setHold: (scope) => setHold(scope, db),
    clearHold: (scope) => clearHold(scope, db),
    holdStatus: (scope, ids) => holdStatus(scope, ids, db),
    invalidate: () => undefined,
    startJobs: (id) => started.push(id),
  };
  const post = async (body: unknown, authorization = `Bearer ${VALUE}`) => {
    const res = await handleHoldsPost(
      new Request("https://app.test/api/internal/holds", {
        method: "POST",
        headers: { authorization },
        body: JSON.stringify(body),
      }),
      deps,
    );
    return { status: res.status, body: await res.json() };
  };
  const get = async (query: string) => {
    const res = await handleHoldsGet(
      new Request(`https://app.test/api/internal/holds?${query}`, {
        headers: { authorization: `Bearer ${VALUE}` },
      }),
      deps,
    );
    return { status: res.status, body: await res.json() };
  };

  assert.equal((await post({ action: "hold", organizationId: ORG }, "Bearer rtl_k")).status, 401);
  for (const bad of [
    {},
    { action: "move", organizationId: ORG },
    { action: "hold", projectIds: [] },
    { action: "hold", organizationId: ORG, projectIds: [A] },
  ]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post({ action: "hold", organizationId: B })).status, 404);

  const held = await post({ action: "hold", organizationId: ORG });
  assert.deepEqual([held.status, held.body.state, held.body.projectIds], [200, "held", [A, A2]]);
  assert.equal((await get(`organizationId=${ORG}`)).body.state, "held");
  assert.equal((await get(`organizationId=${OTHER_ORG}`)).body.state, "none");
  assert.deepEqual(started, []);
  assert.equal((await post({ action: "clear", organizationId: ORG })).body.state, "none");
  assert.deepEqual(started, [A, A2]);
  await post({ action: "clear", organizationId: ORG });
  assert.equal(started.length, 2, "nothing was held: nothing starts");

  await post({ action: "hold", projectIds: [A] });
  assert.equal((await get(`projectId=${A}`)).body.state, "held");
  assert.equal((await get(`projectId=${A}&projectId=${A2}`)).body.state, "none");
  deps.config = { internal: { secret: undefined } };
  assert.equal((await get(`projectId=${A}`)).status, 404);
});

test("the status waits for running jobs and for requests from before the hold", async () => {
  const { client, db } = await setup();
  const scope = { kind: "organization", organizationId: ORG } as const;
  await client.exec(
    `insert into jobs (project_id, kind, status) values ('${A}', 'x', 'running'), ('${A2}', 'x', 'queued')`,
  );
  await setHold(scope, db);
  const later = () => new Date(Date.now() + HOLD_SETTLE_MS + 1_000);
  const running = await holdStatus(scope, [A, A2], db, later);
  assert.deepEqual([running.runningJobs, running.queuedJobs, running.quiet], [1, 1, false]);
  await client.exec(`update jobs set status = 'done' where status = 'running'`);
  assert.equal((await holdStatus(scope, [A, A2], db)).quiet, false);
  const quiet = await holdStatus(scope, [A, A2], db, later);
  assert.equal(quiet.quiet, true);
  await setHold(scope, db);
  assert.equal((await holdStatus(scope, [A, A2], db)).since, quiet.since);
});

test("the console is closed for the workspace on hold, and open for an operator and for others", async () => {
  const { db } = await setup();
  await setHold({ kind: "projects", projectIds: [A] }, db);
  await setHold({ kind: "organization", organizationId: OTHER_ORG }, db);
  const holds = await loadHolds(db);
  const closed = (target: Parameters<typeof consoleClosed>[0], inSupport = false) =>
    consoleClosed(target, {
      projectOnHold: async (p) =>
        holds.projects.has(p.id) || holds.organizations.has(p.organizationId),
      organizationOnHold: async (id) => holds.organizations.has(id),
      inSupportSession: async () => inSupport,
    });
  assert.equal(await closed({ project: { id: A, organizationId: ORG } }), true);
  assert.equal(await closed({ project: { id: A2, organizationId: ORG } }), false);
  assert.equal(await closed({ organizationId: ORG }), false);
  assert.equal(await closed({ project: { id: B, organizationId: OTHER_ORG } }), true);
  assert.equal(await closed({ organizationId: OTHER_ORG }), true);
  assert.equal(await closed({ organizationId: OTHER_ORG }, true), false);
});

test("a failed read keeps the last answer", async () => {
  let clock = 0;
  const held = { projects: new Set([A]), organizations: new Set<string>() };
  let load = async () => held as typeof NO_HOLDS;
  const reader = createHoldReader({ now: () => clock, load: () => load() });
  assert.equal(await reader.read(), held);
  clock += HOLD_CACHE_MS;
  load = async () => {
    throw new Error("db down");
  };
  assert.equal(await reader.read(), held);
  load = async () => NO_HOLDS;
  reader.invalidate();
  assert.equal(await reader.read(), NO_HOLDS);
});
