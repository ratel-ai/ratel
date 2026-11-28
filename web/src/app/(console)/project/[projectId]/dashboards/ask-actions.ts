"use server";

import { findProjectScope, type ProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { parseProjectUuid } from "@/lib/platform/projects/queries";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { reportServerException } from "@/lib/platform/telemetry";
import { draftedDashboard } from "@/lib/views/ask/build";
import { ASK_OUTCOMES, ASK_TARGETS, type AskOutcome, type AskTarget } from "@/lib/views/ask/domain";
import { type DraftResult, draftWidgets } from "@/lib/views/ask/draft";
import { linkAsk, setAskOutcome } from "@/lib/views/ask/store";
import { loadSuggestions, type Suggestions } from "@/lib/views/ask/suggest-pick";
import { changeDashboard } from "@/lib/views/dashboards/actions";
import { getDashboard } from "@/lib/views/dashboards/store";
import { isWidget } from "@/lib/views/dashboards/stored-widget";
import { MAX_DASHBOARD_NAME } from "@/lib/views/dashboards/types";
import { consoleDashboardDeps } from "./dashboard-deps";

/**
 * Ask in words in the console's dialogs: a draft from words, the suggested
 * prompts, the outcome of a draft, and a dashboard built from words. A widget draft saves nothing:
 * the dialog saves through `changeDashboardAction`. A dashboard build makes the dashboard at once,
 * with no confirm step (decision `ask-no-confirm`). A support session reads only: it may not ask.
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

export type BuildDashboardResult =
  | { ok: true; dashboardId: string; askId: string }
  | { ok: false; message: string; notSetUp?: true };

/**
 * A new dashboard from words: drafts up to 8 widgets and makes the dashboard of the good ones in
 * one write, as an import does. A refused widget is left out; the dashboard names it from the ask
 * (`?ask=`). With no good widget no dashboard is made, and the ask is discarded. A made dashboard
 * keeps the ask as kept, linked to it and to its widgets.
 */
export async function buildDashboardAction(
  projectId: string,
  input: { title: string; words: string },
): Promise<BuildDashboardResult> {
  const scope = await askScope(projectId, true);
  if (typeof scope === "string") return { ok: false, message: scope };
  const title = String(input.title ?? "").trim();
  if (!title) return { ok: false, message: "Give the dashboard a title." };
  if (title.length > MAX_DASHBOARD_NAME)
    return { ok: false, message: `A title has at most ${MAX_DASHBOARD_NAME} characters.` };
  try {
    const draft = await draftWidgets({
      projectId: scope.project.id,
      actor: scope.user.externalId,
      surface: "console",
      target: "dashboard",
      dashboardId: null,
      words: String(input.words ?? ""),
    });
    if (draft.status === "not_set_up") return { ok: false, message: draft.message, notSetUp: true };
    if (draft.status !== "drafted") return { ok: false, message: draft.message };
    if (draft.widgets.length === 0) {
      await setAskOutcome(scope.project.id, draft.askId, "discarded");
      const first = draft.refused[0];
      return {
        ok: false,
        message: first
          ? `No widget passed the RQL check, so no dashboard was made. ${first.reason}`
          : "The draft had no widget, so no dashboard was made. Say it in other words.",
      };
    }
    const made = await changeDashboard(
      {
        projectId: scope.project.id,
        action: "import",
        document: draftedDashboard(title, draft.widgets, draft.range),
      },
      consoleDashboardDeps(),
    );
    if (!made.ok) {
      await setAskOutcome(scope.project.id, draft.askId, "discarded");
      return { ok: false, message: made.error };
    }
    const dashboard = await getDashboard(scope.project.id, made.dashboardId);
    await linkAsk(scope.project.id, draft.askId, {
      dashboardId: made.dashboardId,
      widgetIds: (dashboard?.widgets ?? []).filter(isWidget).map(({ id }) => id),
    });
    return { ok: true, dashboardId: made.dashboardId, askId: draft.askId };
  } catch (err) {
    logger.error({ err }, "ask build failed");
    reportServerException(err, "system:dashboards", { operation: "ask_build" });
    return { ok: false, message: "Could not build the dashboard. Try again." };
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

/** The caller's project, or why not. `asks`: a support session may not. */
async function askScope(projectId: string, asks: boolean): Promise<ProjectScope | string> {
  if (!isDbConfigured()) return "No database is connected.";
  const scope = await findProjectScope(projectId);
  if (!scope) return "You cannot read this project.";
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
