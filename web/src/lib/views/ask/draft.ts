import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import type { RangePreset } from "@/lib/synthesis/dashboard";
import type { DashboardsDb } from "@/lib/views/dashboards/store";
import { loadAskContext } from "./context";
import {
  type AskContext,
  type AskTarget,
  buildAskRequest,
  buildRepairRequest,
  type CheckOptions,
  checkCandidates,
  type DraftedWidget,
  mergeRepair,
  parseAskAnswer,
  type RefusedWidget,
  wordsProblem,
} from "./domain";
import { ASK_MAX_WIDGETS } from "./limits";
import {
  type AskModel,
  askCallUsd,
  askModelFromEnv,
  askReserveUsd,
  recordAskRefusal,
  recordNoAskKey,
} from "./model";
import { type AskDb, type AskLimit, holdAsk, settleAsk } from "./store";

/**
 * Ask in words: drafts widgets from the person's words for one project. The draft is checked by
 * the RQL compiler, with one repair round for the widgets it refuses; a widget still refused is
 * named with its reason. The ask is stored with its draft, and nothing else: no widget and no
 * dashboard is saved until the person confirms, through the dashboard's own actions.
 */

export interface DraftAsk {
  projectId: string;
  /** The person, or `project:<id>` for an API key. */
  actor: string;
  surface: "console" | "mcp";
  target: AskTarget;
  /** The dashboard of a widget ask; null for a new dashboard. */
  dashboardId: string | null;
  words: string;
  /** The page's range; the last 7 days by default. */
  range?: { from: string; to: string };
}

export type DraftResult =
  | {
      status: "drafted";
      askId: string;
      model: string;
      widgets: DraftedWidget[];
      refused: RefusedWidget[];
      /** The range the words name, when the dashboard page offers it; null: the page's range. */
      range: RangePreset | null;
    }
  | { status: "not_set_up"; message: string }
  | { status: "invalid"; message: string }
  | { status: "limited"; limit: AskLimit; resetsAt: string; message: string }
  | { status: "failed"; askId: string; message: string };

export interface DraftDeps {
  /** Null: no model is configured. */
  model?: AskModel | null;
  db?: AskDb & DashboardsDb;
  now?: () => Date;
  loadContext?: (
    projectId: string,
    target: AskTarget,
    dashboardId: string | null,
  ) => Promise<AskContext>;
}

export const NOT_SET_UP = "Ask in words needs a model, and this deployment has no model key.";
const FAILED = "The model did not give a draft. Ask again.";
const DEFAULT_RANGE_MS = 7 * 86_400_000;

const logger = getLogger("ask/draft");

export async function draftWidgets(ask: DraftAsk, deps: DraftDeps = {}): Promise<DraftResult> {
  const problem = wordsProblem(ask.words);
  if (problem) return { status: "invalid", message: problem };
  const model = deps.model === undefined ? askModelFromEnv() : deps.model;
  if (!model) {
    recordNoAskKey();
    return { status: "not_set_up", message: NOT_SET_UP };
  }
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();
  const words = ask.words.trim();
  const range = ask.range ?? {
    from: new Date(now.getTime() - DEFAULT_RANGE_MS).toISOString(),
    to: now.toISOString(),
  };
  const load = deps.loadContext ?? ((p, t, d) => loadAskContext(p, t, d, db));
  const context = await load(ask.projectId, ask.target, ask.dashboardId);
  const request = buildAskRequest({ target: ask.target, words, range }, context);
  const reserveUsd = askReserveUsd(model.model, request);

  const hold = await holdAsk(
    {
      projectId: ask.projectId,
      actor: ask.actor,
      surface: ask.surface,
      target: ask.target,
      dashboardId: ask.dashboardId,
      words,
      model: model.model,
      reserveUsd,
      now,
    },
    db,
  );
  if (!hold.ok) {
    recordAskRefusal(model);
    return {
      status: "limited",
      limit: hold.limit,
      resetsAt: hold.resetsAt.toISOString(),
      message: hold.message,
    };
  }

  const check: CheckOptions = { now, properties: context.properties, range };
  let usd = 0;
  const tokens = { inputTokens: 0, outputTokens: 0, repairRounds: 0 };
  let failed = false;
  const call = async (sent: typeof request) => {
    try {
      const answer = await model.complete(sent);
      usd += askCallUsd(model.model, answer.usage);
      tokens.inputTokens += answer.usage.inputTokens;
      tokens.outputTokens += answer.usage.outputTokens;
      return parseAskAnswer(answer.text);
    } catch (err) {
      // A failed call may still be charged: it keeps its share of the reservation.
      failed = true;
      logger.error(
        { project_id: ask.projectId, error_type: err instanceof Error ? err.name : typeof err },
        "ask draft call failed",
      );
      return null;
    }
  };

  const first = await call(request);
  if (!first) {
    await settleAsk(hold.askId, { usd: failed ? reserveUsd : usd, ...tokens }, null, db);
    return { status: "failed", askId: hold.askId, message: FAILED };
  }
  const checked = checkCandidates(first.widgets, ask.target, check);
  let widgets = checked.widgets;
  let refused = checked.refused;
  if (refused.length > 0 && widgets.length < ASK_MAX_WIDGETS[ask.target]) {
    tokens.repairRounds += 1;
    const repair = await call(buildRepairRequest(request, refused));
    if (repair)
      ({ widgets, refused } = mergeRepair({ widgets, refused }, repair.widgets, ask.target, check));
  }
  await settleAsk(
    hold.askId,
    { usd: failed ? Math.max(usd, reserveUsd / 2) : usd, ...tokens },
    { widgets, refused },
    db,
  );
  return {
    status: "drafted",
    askId: hold.askId,
    model: model.model,
    widgets,
    refused,
    range: first.range,
  };
}
