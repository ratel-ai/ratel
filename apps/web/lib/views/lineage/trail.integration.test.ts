import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import {
  defaultLoopDeps,
  type LoopOperationDeps,
  loopWriteOperations,
} from "@/lib/mcp/operations/loop";
import { buildRegistry } from "@/lib/mcp/registry";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  type Db,
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { listOpenSignals } from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { createFixShipment, listProjectShipments } from "@/lib/views/fixes/loop-queries";
import { fixStats } from "@/lib/views/fixes/select";
import { shippedByFix } from "@/lib/views/fixes/shipped";
import type { Fix, FixesModel } from "@/lib/views/fixes/types";
import { evalRef, fixRef } from "./refs";
import { recordLineage } from "./resolve";
import { loadShipments } from "./shipments";
import { shipmentTrail } from "./trail";

/**
 * RC-71: a shipment recorded through MCP's `mark_fix_shipped` opens on Ship
 * with its whole trail, trace › insight › fix › (eval) › shipment, each step
 * linked, read with `chainOf` on the rows the tool wrote.
 */

const NOW = new Date("2026-09-02T00:00:00Z");
const PROPOSAL = "33333333-3333-4333-8333-333333333333";
const EVAL_SET = "66666666-6666-4666-8666-666666666666";
const ACTOR = { distinctId: "system:test" } as const;

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT_ID,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

async function project() {
  const { client, db } = await setupDb();
  let n = 0;
  const trace = () => ({ traceId: `trace-${(n++).toString().padStart(4, "0")}` });
  await seedLedger(client, db, [
    ...times(130, () =>
      fresh(trace())
        .search(["create_task", "search_tasks"], { query: "find my open tasks" })
        .invoke("search_tasks"),
    ),
    ...times(25, () =>
      fresh(trace())
        .search(["find_task"])
        .invoke("find_task")
        .search(["assign_task"])
        .invoke("assign_task"),
    ),
  ]);
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const [insight] = await listOpenSignals(PROJECT_ID, db);
  assert.ok(insight, "the run raised an insight");
  return { client, db, insight };
}

/** A fix as Fixes builds it, cut to what the tool reads. */
function fixOf(over: Partial<Fix> & Pick<Fix, "id" | "source" | "sourceId">): Fix {
  return {
    aliases: [over.id],
    title: "Merge search_tasks into create_task",
    short: "Merge 2 tools into one",
    why: "They run together.",
    kind: "merge" as Fix["kind"],
    kindLabel: "Merge",
    group: "tools" as Fix["group"],
    status: "open",
    subject: { tools: [], tasks: [], topics: [] },
    effect: null,
    gain: null,
    evidence: null,
    issues: [],
    actions: {
      apply: false,
      dismiss: false,
      revert: false,
      catalogHref: null,
      copy: null,
      descriptionHref: null,
    },
    detail: { source: "issue", changes: ["Merge them."], caveat: null },
    rank: { tier: 3, score: 0, count: 0 },
    appliedAt: null,
    ...over,
  };
}

/** `mark_fix_shipped` as an API key calls it, writing to this database. */
async function markShipped(db: Db, fix: Fix, version: string) {
  const model: FixesModel = {
    projectId: PROJECT_ID,
    open: [fix],
    applied: [],
    stats: {
      open: 1,
      ready: 0,
      fromIssues: 0,
      issues: 0,
      tools: 0,
      roundTripsSaved: null,
      savings: fixStats([]).savings,
      evidence: { early: 0, solid: 0, strong: 0, none: 1 },
    },
    failed: [],
    rewritesOn: false,
    overridesAdopted: null,
  };
  const deps: LoopOperationDeps = {
    ...defaultLoopDeps,
    loadProjectFixes: async () => model,
    loadInsight: async () => null,
    recordLineage: (input) => recordLineage(input, db),
    createFixShipment: (input) => createFixShipment(input, db),
    trackServerEvent: (async () => undefined) as LoopOperationDeps["trackServerEvent"],
  };
  const result = await dispatchOperation(
    "mark_fix_shipped",
    { fixId: fix.id, version },
    { registry: buildRegistry(loopWriteOperations(deps)), auth },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
}

test("a shipment marked shipped over MCP opens on Ship with its trail, the fix's insight derived from the issue that names it", async () => {
  const { client, db, insight } = await project();
  // A drafted change that names no insight itself: Agent health's issue names its proposal.
  await client.query(
    `update trace_signals set proposal_kind = 'tool_craft', proposal_id = $1 where id = $2`,
    [PROPOSAL, insight.id],
  );
  const fix = fixOf({ id: `craft:${PROPOSAL}`, source: "craft", sourceId: PROPOSAL });
  await markShipped(db, fix, "v2.5.0");

  const rows = await loadShipments(PROJECT_ID, db);
  assert.equal(rows.length, 1);
  const shipment = rows[0]!;
  assert.match(shipment.title, /shipped in v2\.5\.0$/);

  const trail = await shipmentTrail(
    shipment.ref,
    { projectId: PROJECT_ID, db, evals: true },
    shipment.source,
  );
  assert.deepEqual(
    trail.map((ref) => `${ref.stage}/${ref.kind}`),
    ["monitor/trace", "insights/insight", "improve/fix", "ship/shipment"],
  );
  assert.equal(trail[1]!.id, insight.id, "derived: the issue that names the fix's proposal");
  assert.equal(trail[2]!.id, fix.id);
  assert.equal(
    trail[2]!.label,
    "Merge search_tasks into create_task",
    "the fix keeps the title the tool recorded",
  );
  assert.equal(trail.at(-1)!.id, shipment.ref.id);
  assert.ok(
    trail.every(
      (ref) => typeof ref.href === "string" && ref.href.startsWith(`/project/${PROJECT_ID}/`),
    ),
    "every step links",
  );
  assert.equal(
    trail[2]!.href,
    `/project/${PROJECT_ID}/improvement/fixes?peek=${encodeURIComponent(fix.id)}`,
  );
  assert.equal(trail.at(-1)!.href, `/project/${PROJECT_ID}/ship?peek=${shipment.ref.id}`);

  // Once the eval gate simulated the fix, its eval sits between the fix and the shipment.
  await client.query(
    `insert into fix_eval_sets (id, project_id, fix_id, fix_kind, title) values ($1, $2, $3, 'merge', 'Merge 2 tools')`,
    [EVAL_SET, PROJECT_ID, fix.id],
  );
  await recordLineage(
    {
      projectId: PROJECT_ID,
      object: evalRef(PROJECT_ID, EVAL_SET, fix.id),
      source: fixRef(fix.id),
      actor: ACTOR,
    },
    db,
  );
  const withEval = await shipmentTrail(
    shipment.ref,
    { projectId: PROJECT_ID, db, evals: true },
    shipment.source,
  );
  assert.deepEqual(
    withEval.map((ref) => ref.kind),
    ["trace", "insight", "fix", "eval", "shipment"],
  );
  assert.equal(withEval[3]!.label, "Eval: Merge 2 tools");
  assert.equal(
    withEval[3]!.href,
    `/project/${PROJECT_ID}/improvement/fixes/${encodeURIComponent(fix.id)}/eval`,
  );

  const gateOff = await shipmentTrail(
    shipment.ref,
    { projectId: PROJECT_ID, db, evals: false },
    shipment.source,
  );
  assert.deepEqual(
    gateOff.map((ref) => ref.kind),
    ["trace", "insight", "fix", "shipment"],
    "no eval page to open with the gate off",
  );
});

test("an issue's fix marked shipped walks back through the insight the tool recorded", async () => {
  const { db, insight } = await project();
  const fix = fixOf({
    id: `issue:${insight.id}`,
    source: "issue",
    sourceId: insight.id,
    issues: [
      {
        id: insight.id,
        kind: insight.kind,
        title: "Tool keeps failing",
        claim: "c",
        cost: "c",
        figure: null,
        href: `/project/${PROJECT_ID}/health#signal-${insight.id}`,
      },
    ],
  });
  await markShipped(db, fix, "v1.0.0");
  const [shipment] = await loadShipments(PROJECT_ID, db);
  const trail = await shipmentTrail(shipment!.ref, { projectId: PROJECT_ID, db }, shipment!.source);
  assert.deepEqual(
    trail.map((ref) => ref.kind),
    ["trace", "insight", "fix", "shipment"],
  );
  assert.equal(trail[1]!.label, "Tool keeps failing");
});

test("a fix marked shipped over MCP reads as shipped, in its newest version, wherever Fixes asks (RC-72)", async () => {
  const { db, insight } = await project();
  const fix = fixOf({ id: `issue:${insight.id}`, source: "issue", sourceId: insight.id });
  assert.deepEqual(
    shippedByFix(PROJECT_ID, await listProjectShipments(PROJECT_ID, db)),
    {},
    "nothing shipped yet",
  );
  await markShipped(db, fix, "v2.4.0");
  await markShipped(db, fix, "v2.5.0");
  const shipped = shippedByFix(PROJECT_ID, await listProjectShipments(PROJECT_ID, db));
  assert.deepEqual(Object.keys(shipped), [fix.id]);
  assert.equal(shipped[fix.id]!.version, "v2.5.0");
  assert.match(
    shipped[fix.id]!.href,
    new RegExp(`^/project/${PROJECT_ID}/ship\\?peek=${shipped[fix.id]!.shipmentId}$`),
  );
  assert.deepEqual(
    await listProjectShipments("99999999-9999-4999-8999-999999999999", db),
    [],
    "another project reads nothing",
  );
});
