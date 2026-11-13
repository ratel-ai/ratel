import { SITE_USERS, type SiteRole, type SiteUser } from "@/lib/console/seed/site-copilot-catalog";
import {
  between,
  chance,
  hexOf,
  pick,
  type Rng,
  rngFor,
  weighted,
} from "@/lib/console/seed/site-copilot-rng";
import {
  changeOrder,
  changeOrderRefine,
  correction,
  equipmentRental,
  handoff,
  inspectionBooking,
  materialDelivery,
  paymentStatus,
  restate,
  retainage,
  retryable,
  rfiDraft,
  rfiStatus,
  SITE_TOPICS,
  type SiteCall,
  type SiteMemory,
  type SiteTopicId,
  type SiteTurnDraft,
  type SiteTurnKind,
  safetyChecklist,
  safetyReport,
  scheduleImpact,
  scheduleStatus,
  specQuestion,
  subcontractors,
  type TurnContext,
  type TurnOptions,
  thanks,
  tryAgain,
  weatherRisk,
} from "@/lib/console/seed/site-copilot-turns";

/**
 * The Site Copilot demo's conversations, planned before any clock is read:
 * about 1,500 turns in conversations of 1 to 6 turns, each turn an ask, the
 * tool calls the agent made for it and its reply (`site-copilot-turns.ts`).
 * What comes next depends on what just happened: a failure is followed by
 * "Can you try again?" or the same ask again, a wrong answer by "That's not
 * right", an answer by a related ask (estimate a change order, refine it,
 * ask its schedule impact), a thanks or a new topic.
 *
 * Pure and deterministic: the same seed and turn count give the same plan,
 * whatever the date. `site-copilot-otlp.ts` places it on a calendar.
 */

export const SITE_COPILOT_SEED = 20_261_020;
export const SITE_COPILOT_TURNS = 1_500;

export interface SitePlanOptions {
  seed?: number;
  /** Total turns across all conversations. */
  turns?: number;
}

export interface SiteTurn extends SiteTurnDraft {
  key: string;
  index: number;
  /** From the previous turn's reply to this ask, ms; 0 for a conversation's first turn. */
  gapBeforeMs: number;
  /** One per model call, in order: one before each tool call and one for the reply. */
  modelMs: number[];
}

export interface SiteConversation {
  key: string;
  /** `gen_ai.conversation.id`. */
  id: string;
  userId: string;
  /** Where the conversation starts, 0 (oldest) to 1 (newest), before a calendar is applied. */
  position: number;
  turns: SiteTurn[];
}

export interface SitePlanStats {
  conversations: number;
  turns: number;
  /** Turns whose agent called no tool: they leave model calls but no run. */
  turnsWithoutTools: number;
  byKind: Record<string, number>;
  byTopic: Record<string, number>;
  toolCalls: number;
  /** Failed calls by `tool error_type`. */
  failedCalls: Record<string, number>;
  /** After a failed call: the same tool later, another tool next, or nothing after. */
  behaviors: { retry: number; switch: number; gaveUp: number };
  /** Runs of two or more distinct tools, by their tools in first-call order. */
  chains: Record<string, number>;
}

export interface SitePlan {
  seed: number;
  conversations: SiteConversation[];
  stats: SitePlanStats;
}

/** Turns a conversation holds at most. */
export const SITE_COPILOT_MAX_TURNS = 6;

/**
 * How likely the user asks something more after each kind of turn: a failure
 * or a wrong answer keeps them talking, a thanks usually ends it.
 */
const CONTINUE: Record<SiteTurnDraft["outcome"] | "wrong", number> = {
  answered: 0.42,
  failed: 0.78,
  unanswerable: 0.62,
  closing: 0.12,
  wrong: 0.9,
};

const ROLE_ACTIVITY: Record<SiteRole, number> = {
  superintendent: 1.3,
  project_manager: 1.15,
  project_engineer: 1,
  safety_manager: 0.7,
  foreman: 0.8,
};

const TOPIC_WEIGHTS: Record<SiteTopicId, number> = {
  material_delivery: 17,
  schedule_status: 16,
  change_orders: 11,
  rfis: 10,
  spec_question: 8,
  safety_report: 7,
  payment_status: 8,
  subcontractors: 7,
  equipment_rental: 4,
  inspection_booking: 4.5,
};

const ROLE_BIAS: Record<SiteRole, Partial<Record<SiteTopicId, number>>> = {
  superintendent: {
    schedule_status: 1.4,
    material_delivery: 1.3,
    equipment_rental: 1.3,
    inspection_booking: 1.3,
    payment_status: 0.3,
    change_orders: 0.6,
  },
  project_manager: {
    payment_status: 2.2,
    change_orders: 1.7,
    rfis: 1.2,
    equipment_rental: 0.4,
    inspection_booking: 0.6,
  },
  project_engineer: { rfis: 1.9, spec_question: 2, change_orders: 1.2, payment_status: 0.5 },
  safety_manager: {
    safety_report: 6,
    subcontractors: 1.6,
    material_delivery: 0.4,
    change_orders: 0.3,
    payment_status: 0.2,
  },
  foreman: {
    material_delivery: 1.5,
    schedule_status: 1.2,
    safety_report: 1.6,
    equipment_rental: 1.3,
    payment_status: 0.1,
    change_orders: 0.3,
  },
};

/** The asks that tend to follow an answered one, and how often. */
const CONTINUATIONS: Partial<Record<SiteTurnKind, { kind: SiteTurnKind; p: number }>> = {
  change_orders: { kind: "change_order_refine", p: 0.65 },
  change_order_refine: { kind: "schedule_impact", p: 0.55 },
  schedule_impact: { kind: "schedule_status", p: 0.35 },
  material_delivery: { kind: "schedule_impact", p: 0.22 },
  rfis: { kind: "rfi_draft", p: 0.25 },
  safety_report: { kind: "safety_checklist", p: 0.25 },
  schedule_status: { kind: "weather_risk", p: 0.15 },
  payment_status: { kind: "retainage", p: 0.2 },
};

const GAP_MS: Partial<Record<SiteTurnKind, readonly [number, number]>> = {
  try_again: [8_000, 60_000],
  asked_again: [15_000, 150_000],
  correction: [20_000, 100_000],
  thanks: [5_000, 45_000],
  handoff: [15_000, 90_000],
  change_order_refine: [40_000, 240_000],
  schedule_impact: [30_000, 200_000],
  rfi_draft: [30_000, 180_000],
  safety_checklist: [30_000, 200_000],
  weather_risk: [20_000, 150_000],
  retainage: [20_000, 150_000],
};
const NEW_TOPIC_GAP_MS: readonly [number, number] = [60_000, 900_000];

const PRIMARY: Record<SiteTopicId, (ctx: TurnContext, opts: TurnOptions) => SiteTurnDraft> = {
  material_delivery: materialDelivery,
  schedule_status: scheduleStatus,
  spec_question: specQuestion,
  rfis: rfiStatus,
  change_orders: changeOrder,
  payment_status: paymentStatus,
  subcontractors,
  safety_report: safetyReport,
  equipment_rental: equipmentRental,
  inspection_booking: inspectionBooking,
};

const isTopic = (kind: SiteTurnKind): kind is SiteTopicId =>
  (SITE_TOPICS as readonly string[]).includes(kind);

function newTopic(rng: Rng, user: SiteUser, position: number): SiteTopicId {
  return weighted(
    rng,
    SITE_TOPICS.map((topic) => {
      const rising = topic === "equipment_rental" ? 0.6 + 0.9 * position : 1;
      return [topic, TOPIC_WEIGHTS[topic] * (ROLE_BIAS[user.role][topic] ?? 1) * rising] as const;
    }),
  );
}

function nextKind(
  rng: Rng,
  last: SiteTurnDraft,
  user: SiteUser,
  memory: SiteMemory,
  position: number,
): SiteTurnKind {
  if (last.wrong && chance(rng, 0.85)) return "correction";
  if (last.outcome === "failed") {
    if (retryable(last.failedCall) && chance(rng, 0.55)) return "try_again";
    if (memory.lastAsk && chance(rng, 0.4)) return "asked_again";
    if (last.kind === "spec_question" && chance(rng, 0.5)) return "rfi_draft";
    return newTopic(rng, user, position);
  }
  if (last.outcome === "unanswerable") {
    const r = rng();
    if (r < 0.3) return "handoff";
    if (r < 0.55 && memory.lastAsk) return "asked_again";
    return newTopic(rng, user, position);
  }
  if (last.outcome === "answered") {
    const next = CONTINUATIONS[last.kind];
    if (next && chance(rng, next.p)) return next.kind;
    if (chance(rng, 0.24)) return "thanks";
  }
  return newTopic(rng, user, position);
}

function draftTurn(
  kind: SiteTurnKind,
  ctx: TurnContext,
  last: SiteTurnDraft | null,
  failures: number,
): SiteTurnDraft {
  switch (kind) {
    case "try_again":
      return tryAgain(ctx, last!, failures);
    case "asked_again": {
      const topic = ctx.memory.lastKind as SiteTopicId;
      const draft = PRIMARY[topic](ctx, {
        reuse: true,
        ask: restate(ctx.rng, ctx.memory.lastAsk!),
      });
      return { ...draft, kind: "asked_again" };
    }
    case "correction":
      return correction(ctx, last!);
    case "thanks":
      return thanks(ctx);
    case "handoff":
      return handoff(ctx, last!.topic ?? "equipment_rental");
    case "change_order_refine":
      return changeOrderRefine(ctx);
    case "schedule_impact":
      return scheduleImpact(ctx, last?.kind ?? "change_orders");
    case "rfi_draft":
      return rfiDraft(ctx, last?.kind ?? null);
    case "safety_checklist":
      return safetyChecklist(ctx, true);
    case "weather_risk":
      return weatherRisk(ctx);
    case "retainage":
      return retainage(ctx);
    default:
      return PRIMARY[kind](ctx, {});
  }
}

function modelDurations(rng: Rng, draft: SiteTurnDraft): number[] {
  const rounds = draft.calls.length + 1;
  return Array.from({ length: rounds }, (_, i) => {
    if (i === rounds - 1) return Math.round(700 + draft.reply.length * between(rng, 9, 16));
    const say = draft.calls[i]?.say;
    const [min, max] = i === 0 ? [1_100, 3_200] : [650, 2_100];
    return Math.round(between(rng, min, max) + (say ? say.length * 10 : 0));
  });
}

/** Change orders get worked over several turns: estimated, refined, checked against the schedule. */
const ITERATED: ReadonlySet<SiteTurnKind> = new Set(["change_orders", "change_order_refine"]);
const ITERATED_CONTINUE = 0.7;

/** Whether the user asks again after `last`, so long as the conversation has room. */
function continues(rng: Rng, last: SiteTurnDraft, index: number, room: number): boolean {
  if (index >= Math.min(SITE_COPILOT_MAX_TURNS, room)) return false;
  if (last.outcome === "answered" && !last.wrong && ITERATED.has(last.kind))
    return chance(rng, ITERATED_CONTINUE);
  return chance(rng, CONTINUE[last.wrong ? "wrong" : last.outcome]);
}

/** One conversation; `room` caps its turns so the plan lands on its turn count exactly. */
function planConversation(
  rng: Rng,
  key: string,
  id: string,
  room: number,
  position: number,
): SiteConversation {
  const user = weighted(
    rng,
    SITE_USERS.map((u) => [u, ROLE_ACTIVITY[u.role]] as const),
  );
  const memory: SiteMemory = { projectIndex: pick(rng, user.projects) };
  const turns: SiteTurn[] = [];
  let last: SiteTurnDraft | null = null;
  let failures = 0;
  for (let index = 0; last === null || continues(rng, last, index, room); index++) {
    const kind = last ? nextKind(rng, last, user, memory, position) : newTopic(rng, user, position);
    // A new topic may be about another of the user's projects.
    if (last && isTopic(kind) && user.projects.length > 1 && chance(rng, 0.25))
      memory.projectIndex = pick(rng, user.projects);
    const draft = draftTurn(
      kind,
      { rng, user, memory, position, first: index === 0 },
      last,
      failures,
    );
    if (isTopic(draft.kind)) {
      memory.lastAsk = draft.ask;
      memory.lastKind = draft.kind;
    }
    if (draft.outcome === "failed") failures += 1;
    const gap = index === 0 ? null : (GAP_MS[draft.kind] ?? NEW_TOPIC_GAP_MS);
    turns.push({
      ...draft,
      key: `${key}:t${index}`,
      index,
      gapBeforeMs: gap ? Math.round(between(rng, gap[0], gap[1])) : 0,
      modelMs: modelDurations(rng, draft),
    });
    last = draft;
  }
  return { key, id, userId: user.id, position, turns };
}

function failedCallsOf(calls: readonly SiteCall[]): SiteCall[] {
  return calls.filter((call) => call.outcome !== "ok");
}

/** The kinds `lib/trace-signals/self-corrections/detect.ts` reads from a run's calls. */
function behaviorsOf(calls: readonly SiteCall[]): SitePlanStats["behaviors"] {
  const out = { retry: 0, switch: 0, gaveUp: 0 };
  calls.forEach((call, i) => {
    if (call.outcome === "ok") return;
    const later = calls.slice(i + 1);
    if (later.length === 0) {
      out.gaveUp += 1;
      return;
    }
    if (later[0]!.tool !== call.tool) out.switch += 1;
    if (later.some((c) => c.tool === call.tool)) out.retry += 1;
  });
  return out;
}

function count(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function siteCopilotStats(conversations: readonly SiteConversation[]): SitePlanStats {
  const stats: SitePlanStats = {
    conversations: conversations.length,
    turns: 0,
    turnsWithoutTools: 0,
    byKind: {},
    byTopic: {},
    toolCalls: 0,
    failedCalls: {},
    behaviors: { retry: 0, switch: 0, gaveUp: 0 },
    chains: {},
  };
  for (const turn of conversations.flatMap((c) => c.turns)) {
    stats.turns += 1;
    if (turn.calls.length === 0) stats.turnsWithoutTools += 1;
    count(stats.byKind, turn.kind);
    count(stats.byTopic, turn.topic ?? "none");
    stats.toolCalls += turn.calls.length;
    for (const call of failedCallsOf(turn.calls))
      count(stats.failedCalls, `${call.tool} ${call.errorType ?? "result"}`);
    const behaviors = behaviorsOf(turn.calls);
    stats.behaviors.retry += behaviors.retry;
    stats.behaviors.switch += behaviors.switch;
    stats.behaviors.gaveUp += behaviors.gaveUp;
    const tools = [...new Set(turn.calls.map((call) => call.tool))];
    if (tools.length >= 2) count(stats.chains, tools.join(" > "));
  }
  return stats;
}

/**
 * Conversations in order until the turn count is reached. A conversation's
 * position is the share of turns before it, so the window fills evenly and the
 * trends planted by position (the tracking service failing more, equipment
 * rental asked more) follow the calendar once it is applied.
 */
export function planSiteCopilot(opts: SitePlanOptions = {}): SitePlan {
  const seed = opts.seed ?? SITE_COPILOT_SEED;
  const target = opts.turns ?? SITE_COPILOT_TURNS;
  if (!Number.isInteger(target) || target < 1)
    throw new Error(`turns must be a positive integer, not ${target}`);
  const conversations: SiteConversation[] = [];
  let planned = 0;
  while (planned < target) {
    const i = conversations.length;
    const key = `c${String(i).padStart(4, "0")}`;
    const position = Math.min(0.9999, (planned + 0.5) / target);
    const conversation = planConversation(
      rngFor(seed, `conversation:${i}`),
      key,
      `conv_${hexOf(`${seed}:conversation:${i}`, 24)}`,
      target - planned,
      position,
    );
    conversations.push(conversation);
    planned += conversation.turns.length;
  }
  return { seed, conversations, stats: siteCopilotStats(conversations) };
}
