import type { Fix, FixesModel } from "@/lib/views/fixes/types";

/** What a person just did to a fix, before the server's list catches up. */
export type Acted = "applied" | "dismissed" | "reverted";

/**
 * The lists as they are right after an action (DESIGN.md, Performance:
 * mutations update the UI optimistically): an applied rewrite moves from the
 * open list to Applied with Revert, a dismissed one leaves, and a reverted
 * one (Undo included) closes. Safe to keep applying after a refresh: a fix
 * the server already moved is never listed twice.
 */
export function withActed(
  model: Pick<FixesModel, "open" | "applied">,
  acted: ReadonlyMap<string, Acted>,
  now: string,
): { open: Fix[]; applied: Fix[] } {
  const open = model.open.filter((fix) => !acted.has(fix.id));
  const onServer = new Set(model.applied.map((fix) => fix.id));
  const justApplied = model.open
    .filter((fix) => acted.get(fix.id) === "applied" && !onServer.has(fix.id))
    .map(
      (fix): Fix => ({
        ...fix,
        status: "applied",
        appliedAt: now,
        actions: { ...fix.actions, apply: false, dismiss: false, revert: true },
      }),
    );
  const applied = [
    ...justApplied,
    ...model.applied.filter((fix) => acted.get(fix.id) !== "reverted"),
  ];
  return { open, applied };
}
