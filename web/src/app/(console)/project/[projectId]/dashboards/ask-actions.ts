"use server";

import { findProjectScope, type ProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { parseProjectUuid } from "@/lib/platform/projects/queries";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { reportServerException } from "@/lib/platform/telemetry";
import { ASK_OUTCOMES, ASK_TARGETS, type AskOutcome, type AskTarget } from "@/lib/views/ask/domain";
import { type DraftResult, draftWidgets } from "@/lib/views/ask/draft";
import { setAskOutcome } from "@/lib/views/ask/store";
import { loadSuggestions, type Suggestions } from "@/lib/views/ask/suggest-pick";
import { getDashboard } from "@/lib/views/dashboards/store";

/**
 * Ask in words in the console's dialogs (`customMonitoring`): a draft from words, the suggested
 * prompts, and the outcome of a draft. A draft saves no widget: the dialog saves through
 * `changeDashboardAction`. A support session reads only: it may not ask.
 */

const logger = getLogger("dashboards/ask-actions");

export interface AskWidgetsInput {
  target: AskTarget;
  dashboardId: string | null;
  words: string;
  range: { from: string; to: string };
}

/** A draft of widgets from the person's words. */
export async function draftWidgetsAction(
  projectId: string,
  input: AskWidgetsInput,
): Promise<DraftResult> {
  const scope = await askScope(projectId, true);
  if (typeof scope === "string") return { status: "invalid", message: scope };
  const target = ASK_TARGETS.includes(input.target) ? input.target : "widget";
  const dashboardId = input.dashboardId ? parseProjectUuid(input.dashboardId) : null;
  if (input.dashboardId && !(dashboardId && (await getDashboard(scope.project.id, dashboardId))))
    return { status: "invalid", message: "This dashboard no longer exists." };
  try {
    return await draftWidgets({
      projectId: scope.project.id,
      actor: scope.user.externalId,
      surface: "console",
      target,
      dashboardId,
      words: String(input.words ?? ""),
      range: validRange(input.range),
    });
  } catch (err) {
    logger.error({ err }, "ask draft failed");
    reportServerException(err, "system:dashboards", { operation: "ask_draft" });
    return { status: "invalid", message: "Could not ask for a draft. Try again." };
  }
}

/** The prompts a dialog proposes; the fixed order while the decision model is slow. */
export async function askSuggestionsAction(
  projectId: string,
  input: { target: AskTarget; dashboardId: string | null; title?: string },
): Promise<Suggestions> {
  const none: Suggestions = { prompts: [], source: "fixed" };
  const scope = await askScope(projectId, false);
  if (typeof scope === "string") return none;
  const dashboardId = input.dashboardId ? parseProjectUuid(input.dashboardId) : null;
  try {
    return await loadSuggestions(scope.project.id, {
      target: ASK_TARGETS.includes(input.target) ? input.target : "widget",
      dashboardId,
      ...(input.title ? { title: String(input.title).slice(0, 80) } : {}),
    });
  } catch (err) {
    logger.error({ err }, "ask suggestions failed");
    return none;
  }
}

/** What the person did with a draft: kept, edited or discarded. */
export async function setAskOutcomeAction(
  projectId: string,
  askId: string,
  outcome: AskOutcome,
): Promise<{ ok: boolean }> {
  const scope = await askScope(projectId, true);
  const id = parseProjectUuid(askId);
  if (typeof scope === "string" || !id || !ASK_OUTCOMES.includes(outcome)) return { ok: false };
  try {
    return { ok: await setAskOutcome(scope.project.id, id, outcome) };
  } catch (err) {
    logger.error({ err }, "ask outcome failed");
    return { ok: false };
  }
}

/** The caller's project with the flag on, or why not. `asks`: a support session may not. */
async function askScope(projectId: string, asks: boolean): Promise<ProjectScope | string> {
  if (!isDbConfigured()) return "No database is connected.";
  const scope = await findProjectScope(projectId);
  if (!scope) return "You cannot read this project.";
  if (
    !(await featureEnabled("customMonitoring", {
      projectId: scope.project.id,
      organizationId: scope.organization.id,
      actor: scope.user.externalId,
    }))
  )
    return "Dashboards are off for this project.";
  if (asks && (await isRestrictedBySupportSession()))
    return "A support session cannot ask for a draft.";
  return scope;
}

/** The page's range as two valid instants, or none (the draft's default). */
function validRange(range: AskWidgetsInput["range"] | undefined) {
  const from = Date.parse(range?.from ?? "");
  const to = Date.parse(range?.to ?? "");
  return Number.isFinite(from) && Number.isFinite(to) && from < to
    ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
    : undefined;
}
