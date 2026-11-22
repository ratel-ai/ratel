import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { fixEvalSets } from "@/lib/views/eval-gate/schema";
import { lineageLinks } from "@/lib/views/lineage/schema";
import { evalRef } from "./refs";
import { chainOf, type LineageContext } from "./resolve";
import type { LineageRef } from "./types";

/**
 * A shipment's trail on Ship (RC-71): the whole way back from the shipment,
 * oldest first (trace › insight › fix › eval › experiment › shipment), each
 * step with its href.
 *
 * The backbone is `chainOf(shipment)`, so a fix's insight comes from the link
 * the loop recorded or, without one, from the issue that names the fix. An
 * eval is not on that chain (it comes from the fix, the shipment does not
 * come from it), so the newest eval recorded for the trail's fix is placed
 * right after the fix, when the eval gate is on for the reader.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TrailContext extends LineageContext {
  /** May the trail name the fix's eval? Only with `cloud-eval-gate` on, where its page exists. Defaults to false. */
  evals?: boolean;
}

/**
 * `source` is the shipment's source as Ship's list already names it: a step
 * the chain derived without a label (an applied rewrite's fix) borrows its.
 */
export async function shipmentTrail(
  shipment: LineageRef,
  ctx: TrailContext,
  source: LineageRef | null = null,
): Promise<LineageRef[]> {
  const db = ctx.db ?? getDb();
  const chain = (await chainOf(shipment, { ...ctx, db })).map((ref) =>
    source?.label && !ref.label && ref.kind === source.kind && ref.id === source.id
      ? { ...ref, label: source.label }
      : ref,
  );
  if (!ctx.evals || chain.some((ref) => ref.kind === "eval")) return chain;
  const at = chain.findIndex((ref) => ref.kind === "fix");
  if (at < 0) return chain;
  const step = await evalOfFix(db, ctx.projectId, chain[at]!.id);
  return step ? [...chain.slice(0, at + 1), step, ...chain.slice(at + 1)] : chain;
}

/** The newest eval recorded for a fix (`lineage_links` eval → fix), named by its eval set's title. */
async function evalOfFix(
  db: NonNullable<LineageContext["db"]>,
  projectId: string,
  fixId: string,
): Promise<LineageRef | null> {
  if (!UUID.test(projectId)) return null;
  const [link] = await db
    .select({ objectId: lineageLinks.objectId })
    .from(lineageLinks)
    .where(
      and(
        eq(lineageLinks.projectId, projectId),
        eq(lineageLinks.kind, "eval"),
        eq(lineageLinks.sourceKind, "fix"),
        eq(lineageLinks.sourceId, fixId),
      ),
    )
    .orderBy(desc(lineageLinks.createdAt))
    .limit(1);
  if (!link) return null;
  let title: string | null = null;
  if (UUID.test(link.objectId)) {
    const [set] = await db
      .select({ title: fixEvalSets.title })
      .from(fixEvalSets)
      .where(and(eq(fixEvalSets.projectId, projectId), eq(fixEvalSets.id, link.objectId)))
      .limit(1);
    title = set?.title ?? null;
  }
  return evalRef(projectId, link.objectId, fixId, title ? `Eval: ${title}` : undefined);
}
