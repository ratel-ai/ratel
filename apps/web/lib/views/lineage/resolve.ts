import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { type ServerEventContext, trackServerEvent } from "@/lib/platform/telemetry";
import { signalTitle } from "@/lib/readings/trace-signals/claims";
import { traceSignals } from "@/lib/readings/trace-signals/schema";
import { SIGNAL_KINDS, type SignalKind } from "@/lib/readings/trace-signals/view";
import { lineageLinks } from "@/lib/views/lineage/schema";
import { fixRef, hrefFor, insightRef, metricRef, traceRef, withHref } from "./refs";
import { firstTraceOf, sampledTurnIds, traceIdsForTurns } from "./turn-traces";
import { isLineageStage, LINEAGE_STAGES, type LineageRef, stageOfKind } from "./types";

/**
 * Server half of the lineage module (RC-45, the shared contract's
 * `resolve.ts`): one step back (`sourceOf`), the whole way back to Monitor
 * (`chainOf`), where a ref opens (`hrefFor`, re-exported from the pure
 * `refs.ts` so client code can import it without the database), and how a
 * producer records a link the data cannot show (`recordLineage`).
 *
 * A recorded link (`lineage_links`) always wins. Without one, the source is
 * derived from the data:
 *
 * - insight → the run of its newest sampled turn (the trace id is read live,
 *   never stored on the signal), else the reading it fired on (a metric).
 * - fix `issue:<id>` → that insight; `craft:<id>`/`rewrite:<id>` → the insight
 *   that names it (`trace_signals.proposal_kind/_id`).
 * - shipment `rewrite:<id>` (an applied rewrite) → fix `rewrite:<id>`.
 * - experiment, eval, other shipments: only what was recorded.
 *
 * Every read is scoped to the project, so an id from another project
 * resolves to nothing.
 */

export { hrefFor } from "./refs";

export type LineageDb = Pick<ReturnType<typeof getDb>, "select" | "insert">;

export interface LineageContext {
  projectId: string;
  db?: LineageDb;
  /**
   * May an insight name the run it came from? False on a plan without
   * example turns (`agentHealthEvidenceTurns` 0): it then names its metric.
   * Defaults to true.
   */
  traces?: boolean;
}

const logger = getLogger("lineage/resolve");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The spine is four stages; a longer walk is a cycle in recorded links. */
const MAX_CHAIN = 8;

/** Fix id prefixes whose proposal an issue can name, and the `proposal_kind` it names them with. */
const PROPOSAL_KINDS: Readonly<Record<string, string>> = {
  craft: "tool_craft",
  rewrite: "match_quality",
};

/** The object `ref` came from, one step back, with its href; null at the start of the chain or when nothing says. */
export async function sourceOf(ref: LineageRef, ctx: LineageContext): Promise<LineageRef | null> {
  const db = ctx.db ?? getDb();
  const recorded = await recordedSource(db, ctx.projectId, ref);
  const source = recorded ?? (await derivedSource(db, ctx, ref));
  return source ? withHref(source, ctx.projectId) : null;
}

/**
 * The chain that ends at `ref`, oldest first (`[trace, insight, fix,
 * shipment]`), each with its href. Stops where a source is unknown, and on a
 * cycle in recorded links.
 */
export async function chainOf(ref: LineageRef, ctx: LineageContext): Promise<LineageRef[]> {
  const chain: LineageRef[] = [withHref(ref, ctx.projectId)];
  const seen = new Set([`${ref.kind}:${ref.id}`]);
  let current = ref;
  while (chain.length < MAX_CHAIN) {
    const source = await sourceOf(current, ctx);
    if (!source) break;
    const key = `${source.kind}:${source.id}`;
    if (seen.has(key)) break;
    seen.add(key);
    chain.unshift(source);
    current = source;
  }
  return chain;
}

async function recordedSource(
  db: LineageDb,
  projectId: string,
  ref: LineageRef,
): Promise<LineageRef | null> {
  if (!UUID.test(projectId)) return null;
  const [row] = await db
    .select({
      sourceStage: lineageLinks.sourceStage,
      sourceKind: lineageLinks.sourceKind,
      sourceId: lineageLinks.sourceId,
      sourceLabel: lineageLinks.sourceLabel,
    })
    .from(lineageLinks)
    .where(
      and(
        eq(lineageLinks.projectId, projectId),
        eq(lineageLinks.kind, ref.kind),
        eq(lineageLinks.objectId, ref.id),
      ),
    )
    .limit(1);
  if (!row || !isLineageStage(row.sourceStage)) return null;
  return {
    stage: row.sourceStage,
    kind: row.sourceKind,
    id: row.sourceId,
    ...(row.sourceLabel ? { label: row.sourceLabel } : {}),
  };
}

async function derivedSource(
  db: LineageDb,
  ctx: LineageContext,
  ref: LineageRef,
): Promise<LineageRef | null> {
  switch (ref.kind) {
    case "insight":
      return insightSource(db, ctx, ref.id);
    case "fix":
      return fixSource(db, ctx.projectId, ref.id);
    case "shipment":
      return ref.id.startsWith("rewrite:") ? fixRef(ref.id) : null;
    default:
      return null;
  }
}

function isSignalKind(kind: string): kind is SignalKind {
  return (SIGNAL_KINDS as readonly string[]).includes(kind);
}

function insightLabel(kind: string): string | undefined {
  return isSignalKind(kind) ? signalTitle(kind) : undefined;
}

async function insightSource(
  db: LineageDb,
  ctx: LineageContext,
  signalId: string,
): Promise<LineageRef | null> {
  if (!UUID.test(signalId) || !UUID.test(ctx.projectId)) return null;
  const [signal] = await db
    .select({ kind: traceSignals.kind, evidence: traceSignals.evidence })
    .from(traceSignals)
    .where(and(eq(traceSignals.projectId, ctx.projectId), eq(traceSignals.id, signalId)))
    .limit(1);
  if (!signal) return null;
  if (ctx.traces !== false) {
    const turnIds = sampledTurnIds(signal.evidence);
    const traceId = firstTraceOf(turnIds, await traceIdsForTurns(ctx.projectId, turnIds, db));
    if (traceId) return traceRef(traceId);
  }
  return metricRef(signal.kind, insightLabel(signal.kind));
}

async function fixSource(
  db: LineageDb,
  projectId: string,
  fixId: string,
): Promise<LineageRef | null> {
  const colon = fixId.indexOf(":");
  if (colon < 0) return null;
  const prefix = fixId.slice(0, colon);
  const id = fixId.slice(colon + 1);
  if (prefix === "issue") {
    if (!UUID.test(id) || !UUID.test(projectId)) return null;
    const [signal] = await db
      .select({ kind: traceSignals.kind })
      .from(traceSignals)
      .where(and(eq(traceSignals.projectId, projectId), eq(traceSignals.id, id)))
      .limit(1);
    return signal ? insightRef(id, insightLabel(signal.kind)) : null;
  }
  if (prefix === "intent") return { stage: "insights", kind: "intent", id };
  const proposalKind = PROPOSAL_KINDS[prefix];
  if (!proposalKind || !UUID.test(projectId)) return null;
  const [signal] = await db
    .select({ id: traceSignals.id, kind: traceSignals.kind })
    .from(traceSignals)
    .where(
      and(
        eq(traceSignals.projectId, projectId),
        eq(traceSignals.proposalKind, proposalKind),
        eq(traceSignals.proposalId, id),
      ),
    )
    .limit(1);
  return signal ? insightRef(signal.id, insightLabel(signal.kind)) : null;
}

/* - Recording ------------------------------------------------------------------ */

export interface RecordLineageInput {
  projectId: string;
  /** The object that came from `source`. */
  object: LineageRef;
  source: LineageRef;
  /** Who recorded it, as `trackServerEvent` identifies them (a Clerk id, the project for an API key, a system job). */
  actor: ServerEventContext;
}

/**
 * Records where an object came from, replacing an earlier link for the same
 * object. For objects whose source the data cannot show: an experiment
 * created from an insight, a shipment of a fix (RC-43's `create_experiment`
 * and `mark_fix_shipped`), an eval of a fix (RC-46). A business mutation, so
 * it emits `lineage_link_recorded`.
 */
export async function recordLineage(
  input: RecordLineageInput,
  db: LineageDb = getDb(),
): Promise<LineageRef> {
  const { projectId, object, source, actor } = input;
  for (const ref of [object, source]) {
    if (!LINEAGE_STAGES.includes(ref.stage))
      throw new Error(`unknown lineage stage: ${String(ref.stage)}`);
    if (ref.id.length === 0 || ref.kind.length === 0)
      throw new Error("a lineage ref needs a kind and an id");
  }
  const expected = stageOfKind(object.kind);
  if (expected && expected !== object.stage)
    throw new Error(`a ${object.kind} belongs to ${expected}, not ${object.stage}`);
  const createdBy =
    actor.externalId ?? actor.distinctId ?? (actor.projectId ? `project:${actor.projectId}` : null);
  const values = {
    projectId,
    stage: object.stage,
    kind: object.kind,
    objectId: object.id,
    sourceStage: source.stage,
    sourceKind: source.kind,
    sourceId: source.id,
    sourceLabel: source.label ?? null,
    createdBy,
  };
  await db
    .insert(lineageLinks)
    .values(values)
    .onConflictDoUpdate({
      target: [lineageLinks.projectId, lineageLinks.kind, lineageLinks.objectId],
      set: {
        stage: values.stage,
        sourceStage: values.sourceStage,
        sourceKind: values.sourceKind,
        sourceId: values.sourceId,
        sourceLabel: values.sourceLabel,
        createdBy: values.createdBy,
        createdAt: new Date(),
      },
    });
  logger.info(
    { projectId, stage: object.stage, kind: object.kind, sourceKind: source.kind },
    "lineage link recorded",
  );
  await trackServerEvent("lineage_link_recorded", actor, {
    project_id: projectId,
    stage: object.stage,
    kind: object.kind,
    source_stage: source.stage,
    source_kind: source.kind,
  });
  const href = hrefFor(source, projectId);
  return href ? { ...source, href } : source;
}
