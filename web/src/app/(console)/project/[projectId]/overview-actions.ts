"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  changeOverviewLayout,
  LAYOUT_REFUSALS,
  type LayoutChangeResult,
  type LayoutHistoryEntry,
  type LayoutSnapshot,
  readOverviewHistory,
  restoreOverviewLayout,
  undoOverviewChange,
} from "@/lib/views/overview-layout/actions";
import { postedRevision } from "@/lib/views/overview-layout/domain/history";
import { webLayoutDeps } from "@/lib/views/overview-layout/readers";

const logger = getLogger("overview-layout/actions");

/** `current`: the layout changed in another place, and this is it. */
export interface OverviewLayoutFailure {
  ok: false;
  message: string;
  current?: LayoutSnapshot;
}

type SavedLayout = { ok: true; changed: string | null } & LayoutSnapshot;

export type OverviewLayoutActionResult = SavedLayout | OverviewLayoutFailure;

export type OverviewHistoryActionResult =
  | { ok: true; entries: LayoutHistoryEntry[]; snapshot: LayoutSnapshot }
  | OverviewLayoutFailure;

/**
 * The signed-in person's Overview layout of one project. The project and the person are resolved
 * here; the client posts the project id, the revision it shows and what to do. A page from before
 * the history posts no revision, and is refused as stale.
 */
export async function saveOverviewLayout(
  projectId: string,
  change: unknown,
  base: unknown,
): Promise<OverviewLayoutActionResult> {
  return saved("overview_layout_change", projectId, (id) =>
    changeOverviewLayout(id, change, webLayoutDeps, postedRevision(base)),
  );
}

export async function undoOverviewLayout(
  projectId: string,
  base: unknown,
): Promise<OverviewLayoutActionResult> {
  return saved("overview_layout_undo", projectId, (id) =>
    undoOverviewChange(id, webLayoutDeps, postedRevision(base)),
  );
}

export async function restoreOverviewLayoutEntry(
  projectId: string,
  entryId: unknown,
  base: unknown,
): Promise<OverviewLayoutActionResult> {
  return saved("overview_layout_restore", projectId, (id) =>
    restoreOverviewLayout(id, Number(entryId), webLayoutDeps, postedRevision(base)),
  );
}

export async function loadOverviewHistory(projectId: string): Promise<OverviewHistoryActionResult> {
  return run("overview_layout_history", projectId, async (id) => {
    const result = await readOverviewHistory(id, webLayoutDeps);
    return result.ok ? result : failure(result.reason);
  });
}

// — Helpers ——————————————————————————————————————————————————————————————————

function saved(
  operation: string,
  projectId: string,
  write: (projectId: string) => Promise<LayoutChangeResult>,
): Promise<OverviewLayoutActionResult> {
  return run<SavedLayout>(operation, projectId, async (id) => {
    const result = await write(id);
    if (!result.ok) return { ...failure(result.reason), current: result.current };
    // The page then reads what a widget that came back needs, and Back shows this layout.
    revalidatePath(`/project/${id}`);
    return result;
  });
}

async function run<T extends { ok: true }>(
  operation: string,
  projectId: string,
  work: (projectId: string) => Promise<T | OverviewLayoutFailure>,
): Promise<T | OverviewLayoutFailure> {
  const scope =
    typeof projectId === "string" && isDbConfigured() ? await findProjectScope(projectId) : null;
  if (!scope) return failure("not_found");
  try {
    return await work(scope.project.id);
  } catch (err) {
    logger.error({ err, project_id: scope.project.id, operation }, "overview layout failed");
    reportServerException(err, scope.user.externalId, {
      project_id: scope.project.id,
      operation,
    });
    return { ok: false, message: "Try again." };
  }
}

const failure = (reason: keyof typeof LAYOUT_REFUSALS): OverviewLayoutFailure => ({
  ok: false,
  message: LAYOUT_REFUSALS[reason],
});
