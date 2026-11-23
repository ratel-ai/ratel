import {
  poNumberOf,
  SITE_ACTIVITIES,
  SITE_CHANGE_SCOPES,
  SITE_CHECKLIST_TASKS,
  SITE_EQUIPMENT,
  SITE_INCIDENTS,
  SITE_INSPECTIONS,
  SITE_MATERIALS,
  SITE_PROJECTS,
  SITE_RFI_SUBJECTS,
  SITE_SPEC_ITEMS,
  SITE_SUBS,
  type SiteActivity,
  type SiteMaterial,
  type SiteProject,
  type SiteSpecItem,
  type SiteSub,
  type SiteToolId,
  type SiteUser,
} from "@/lib/console/seed/site-copilot-catalog";
import {
  between,
  chance,
  dollars,
  intBetween,
  ordinal,
  pick,
  type Rng,
} from "@/lib/console/seed/site-copilot-rng";

/**
 * One turn of a Site Copilot conversation, as the user asked it and the agent
 * handled it: the ask, the tool calls in order (with their failures), any
 * text the agent wrote before a call, and the reply. The topic handlers here
 * decide what happens; `site-copilot-plan.ts` decides which turn comes next.
 *
 * The failures and the agent's words are planted at rates a field assistant
 * plausibly shows: the supplier tracking service times out or returns 503
 * (more often late in the window), the agent retries, switches to the daily
 * log or gives up, and apologizes, retries, concedes or backtracks in its
 * replies. Refusals ("I'm sorry, but I can't book rentals") and look-alikes
 * ("You're right on track") are planted too, so a phrase reading has to tell
 * them apart.
 */

export const SITE_TOPICS = [
  "equipment_rental",
  "inspection_booking",
  "payment_status",
  "material_delivery",
  "schedule_status",
  "safety_report",
  "spec_question",
  "subcontractors",
  "rfis",
  "change_orders",
] as const;

export type SiteTopicId = (typeof SITE_TOPICS)[number];

/** Turns that follow another one; each still belongs to a topic (or to none). */
export const SITE_FOLLOW_UP_KINDS = [
  "change_order_refine",
  "schedule_impact",
  "rfi_draft",
  "safety_checklist",
  "weather_risk",
  "retainage",
  "handoff",
  "try_again",
  "asked_again",
  "correction",
  "thanks",
] as const;

export type SiteTurnKind = SiteTopicId | (typeof SITE_FOLLOW_UP_KINDS)[number];

export interface SiteCall {
  tool: SiteToolId;
  args: Record<string, string | number>;
  /** `result_error`: the span succeeds but the result reports a failure. */
  outcome: "ok" | "error" | "result_error";
  result?: unknown;
  /** `error` only: the span's `error.type` and status message. */
  errorType?: string;
  errorMessage?: string;
  tookMs: number;
  /** What the agent wrote in the same model output, before the call. */
  say?: string;
}

export type SiteTurnOutcome = "answered" | "failed" | "unanswerable" | "closing";

export interface SiteTurnDraft {
  kind: SiteTurnKind;
  topic: SiteTopicId | null;
  ask: string;
  calls: SiteCall[];
  reply: string;
  outcome: SiteTurnOutcome;
  /** The failed call a "Can you try again?" repeats, when the turn ended on one. */
  failedCall?: SiteCall;
  /** A wrong answer the user may catch in the next turn. */
  wrong?: "date" | "project" | "rates" | "rfi";
}

/** What a conversation remembers between turns: the things its user asks about. */
export interface SiteMemory {
  projectIndex: number;
  material?: SiteMaterial;
  promised?: string;
  activity?: SiteActivity;
  /** A day of the month the user named, and the one the agent read instead. */
  date?: number;
  wrongDate?: number;
  wrongProjectIndex?: number;
  co?: string;
  scope?: string;
  total?: number;
  rfi?: string;
  rfiSubject?: string;
  /** The RFI number the agent misread (two digits swapped). */
  wrongRfi?: string;
  spec?: SiteSpecItem;
  sub?: SiteSub;
  equipment?: string;
  inspection?: string;
  payApp?: number;
  /** The last turn that asked something new, for a user who asks it again. */
  lastAsk?: string;
  lastKind?: SiteTurnKind;
}

export interface TurnContext {
  rng: Rng;
  user: SiteUser;
  memory: SiteMemory;
  /** 0 (oldest) to 1 (newest): where the conversation sits in the window. */
  position: number;
  /** The conversation's first turn: the agent knows nothing about the user's project yet. */
  first: boolean;
}

/** `reuse` keeps the things the last turn asked about (asked again, corrected); `ask` replaces the drawn ask. */
export interface TurnOptions {
  reuse?: boolean;
  ask?: string;
}

/* --- tools ---------------------------------------------------------------------- */

const LATENCY_MS: Record<SiteToolId, readonly [number, number]> = {
  list_projects: [120, 420],
  get_project_info: [150, 520],
  get_project_schedule: [300, 1_250],
  check_weather_delay: [400, 1_600],
  get_purchase_order: [200, 720],
  track_material_delivery: [850, 3_400],
  get_daily_log: [300, 950],
  search_spec_book: [600, 2_400],
  list_rfis: [200, 640],
  get_rfi: [150, 520],
  create_rfi: [500, 1_500],
  get_change_order: [200, 650],
  estimate_change_order: [1_500, 4_600],
  get_pay_application: [250, 820],
  check_payment_status: [400, 1_800],
  list_subcontractors: [200, 620],
  get_subcontractor_compliance: [400, 1_650],
  log_safety_incident: [400, 1_150],
  get_safety_checklist: [150, 420],
  notify_team: [150, 520],
  update_daily_log: [200, 500],
  export_project_report: [2_000, 6_000],
};

function ok(
  ctx: TurnContext,
  tool: SiteToolId,
  args: SiteCall["args"],
  result: unknown,
  say?: string,
): SiteCall {
  const [min, max] = LATENCY_MS[tool];
  return {
    tool,
    args,
    outcome: "ok",
    result,
    tookMs: Math.round(between(ctx.rng, min, max)),
    ...(say ? { say } : {}),
  };
}

function failed(
  ctx: TurnContext,
  tool: SiteToolId,
  args: SiteCall["args"],
  error: { type: string; message: string; tookMs?: number },
  say?: string,
): SiteCall {
  return {
    tool,
    args,
    outcome: "error",
    errorType: error.type,
    errorMessage: error.message,
    tookMs: error.tookMs ?? Math.round(between(ctx.rng, 80, 450)),
    ...(say ? { say } : {}),
  };
}

function timedOut(
  ctx: TurnContext,
  tool: SiteToolId,
  args: SiteCall["args"],
  limitMs: number,
  what: string,
  say?: string,
): SiteCall {
  return failed(
    ctx,
    tool,
    args,
    {
      type: "timeout",
      message: `${what} timed out after ${limitMs / 1000} s`,
      tookMs: limitMs + intBetween(ctx.rng, 5, 90),
    },
    say,
  );
}

function resultFailed(
  ctx: TurnContext,
  tool: SiteToolId,
  args: SiteCall["args"],
  result: unknown,
): SiteCall {
  const [min, max] = LATENCY_MS[tool];
  return {
    tool,
    args,
    outcome: "result_error",
    result,
    tookMs: Math.round(between(ctx.rng, min, max)),
  };
}

/** The same call again, with a fresh outcome. */
function again(call: SiteCall, next: SiteCall): SiteCall {
  return { ...next, tool: call.tool, args: call.args };
}

const projectOf = (ctx: TurnContext, index = ctx.memory.projectIndex): SiteProject =>
  SITE_PROJECTS[index]!;

function projectList(): unknown {
  return { projects: SITE_PROJECTS.map((p) => ({ id: p.id, name: p.name, status: "active" })) };
}

/** Another project than the conversation's, for the agent that reads the wrong one. */
function otherProjectIndex(ctx: TurnContext): number {
  const others = SITE_PROJECTS.map((_, i) => i).filter((i) => i !== ctx.memory.projectIndex);
  return pick(ctx.rng, others);
}

/** Now and then a user types fast: lower case, no closing mark. */
function styled(rng: Rng, ask: string): string {
  return chance(rng, 0.08) ? ask.toLowerCase().replace(/[?.]$/, "") : ask;
}

const lookupFirst = (ctx: TurnContext): boolean => chance(ctx.rng, ctx.first ? 0.8 : 0.3);

/* --- material delivery ------------------------------------------------------------ */

const PROMISED = ["this Thursday", "next Monday", "the 22nd", "the end of the month", "Friday"];

const DELIVERY_STATES = [
  { status: "in transit", detail: "the carrier's ETA is tomorrow before 10am" },
  { status: "out for delivery", detail: "the driver is due on site this afternoon" },
  { status: "loaded at the supplier's yard", detail: "it ships tonight for delivery in 2 days" },
  {
    status: "held at the carrier's hub",
    detail: "the new ETA is the end of next week, 4 days past the promised date",
  },
  { status: "delivered", detail: "it was signed for at the gate this morning" },
];

const DELIVERY_ASKS: ReadonlyArray<(po: string, material: string, project: string) => string> = [
  (po) => `Check delivery status of ${po}.`,
  (_po, material, project) => `Where is the ${material} for ${project}?`,
  (_po, material, project) => `Is the ${material} delivery for ${project} still on for this week?`,
  (po, material, project) => `Track ${po}, the ${material} for ${project}.`,
  (_po, material, project) => `When does the ${material} arrive at ${project}?`,
  (po) => `${po} delivery status?`,
  (_po, material, project) => `Has the ${material} shipped yet for ${project}?`,
  (_po, material, project) => `Check the delivery status of the ${material} for ${project}.`,
];

const TRACK_RETRY_SAYS: ReadonlyArray<(material: string, project: string) => string> = [
  () => "The tracking service didn't answer. Let me try that again.",
  (material, project) =>
    `Let me try again, the ${material} status for ${project} didn't come back the first time.`,
  () => "No response from the supplier's tracking service. Trying again.",
];

function trackFailure(ctx: TurnContext, args: SiteCall["args"], say?: string): SiteCall {
  return chance(ctx.rng, 0.72)
    ? timedOut(ctx, "track_material_delivery", args, 30_000, "Supplier tracking request", say)
    : failed(
        ctx,
        "track_material_delivery",
        args,
        {
          type: "503",
          message: "503 Service Unavailable: supplier tracking is down for maintenance",
        },
        say,
      );
}

function deliveryReply(
  po: string,
  material: SiteMaterial,
  project: SiteProject,
  state: (typeof DELIVERY_STATES)[number],
): string {
  return `${po} (${material.name} from ${material.supplier}) for ${project.name} is ${state.status}: ${state.detail}.`;
}

function deliveryGaveUp(rng: Rng, po: string, promised: string): string {
  return chance(rng, 0.8)
    ? `I'm sorry, the supplier tracking service didn't respond, so I can't confirm the delivery of ${po} right now. The purchase order shows a promised date of ${promised}.`
    : `The supplier tracking service didn't respond, so I can't confirm where ${po} is. Its promised date is ${promised}.`;
}

export function materialDelivery(ctx: TurnContext, opts: TurnOptions = {}): SiteTurnDraft {
  const { rng, memory } = ctx;
  if (!opts.reuse || !memory.material) {
    memory.material = pick(rng, SITE_MATERIALS);
    memory.promised = pick(rng, PROMISED);
  }
  const material = memory.material;
  const promised = memory.promised ?? PROMISED[0]!;
  const project = projectOf(ctx);
  const po = poNumberOf(material, memory.projectIndex);
  const ask = opts.ask ?? styled(rng, pick(rng, DELIVERY_ASKS)(po, material.name, project.name));
  const calls: SiteCall[] = [];
  if (lookupFirst(ctx)) calls.push(ok(ctx, "list_projects", { status: "active" }, projectList()));
  // Now and then the agent reads the purchase order of another project.
  const slip = !opts.reuse && chance(rng, 0.045);
  const readIndex = slip ? otherProjectIndex(ctx) : memory.projectIndex;
  const readPo = poNumberOf(material, readIndex);
  const readProject = projectOf(ctx, readIndex);
  calls.push(
    ok(
      ctx,
      "get_purchase_order",
      { project_id: readProject.id, material: material.name },
      {
        po_number: readPo,
        supplier: material.supplier,
        items: [material.name],
        promised,
        status: "open",
      },
    ),
  );
  const track = { po_number: readPo };
  const state = pick(rng, DELIVERY_STATES);
  const trackResult = {
    po_number: readPo,
    status: state.status,
    carrier: pick(rng, ["Ryder Freight", "Pilot Logistics", "supplier truck"]),
  };
  const base = { kind: "material_delivery" as const, topic: "material_delivery" as const, ask };
  // The tracking service gets worse over the month.
  if (!chance(rng, 0.14 + 0.24 * ctx.position)) {
    calls.push(ok(ctx, "track_material_delivery", track, trackResult));
    if (slip) memory.wrongProjectIndex = readIndex;
    return {
      ...base,
      calls,
      reply: deliveryReply(readPo, material, readProject, state),
      outcome: "answered",
      ...(slip ? { wrong: "project" as const } : {}),
    };
  }
  const first = trackFailure(ctx, track);
  calls.push(first);
  const r = rng();
  if (r < 0.45) {
    const say = chance(rng, 0.7)
      ? pick(rng, TRACK_RETRY_SAYS)(material.name, project.name)
      : undefined;
    if (chance(rng, 0.6)) {
      calls.push(ok(ctx, "track_material_delivery", track, trackResult, say));
      const lead = chance(rng, 0.3) ? "It came through on the second try. " : "";
      return {
        ...base,
        calls,
        reply: lead + deliveryReply(po, material, project, state),
        outcome: "answered",
      };
    }
    const second = trackFailure(ctx, track, say);
    calls.push(second);
    return {
      ...base,
      calls,
      reply: deliveryGaveUp(rng, po, promised),
      outcome: "failed",
      failedCall: second,
    };
  }
  if (r < 0.65) {
    calls.push(
      ok(
        ctx,
        "get_daily_log",
        { project_id: project.id, days: 2 },
        { deliveries_received: [], crews_on_site: intBetween(rng, 4, 11) },
      ),
    );
    return {
      ...base,
      calls,
      reply: `Supplier tracking is down, so I checked the ${project.name} daily log instead: the ${material.name} hasn't been received at the gate yet. The promised date on ${po} is ${promised}.`,
      outcome: "answered",
    };
  }
  return {
    ...base,
    calls,
    reply: deliveryGaveUp(rng, po, promised),
    outcome: "failed",
    failedCall: first,
  };
}

/* --- schedule status -------------------------------------------------------------- */

const SCHEDULE_ASKS: ReadonlyArray<(activity: string, project: string) => string> = [
  (a, p) => `Is the ${a} at ${p} behind schedule?`,
  (a, p) => `Is the ${a} on ${p} on track or behind?`,
  (a, p) => `How much float is left on the ${a} at ${p}?`,
  (a, p) => `What's the forecast finish for the ${a} at ${p}?`,
  (a, p) => `Are we still on schedule for the ${a} at ${p} this week?`,
];

const DATED_SCHEDULE_ASKS: ReadonlyArray<
  (activity: string, project: string, date: string) => string
> = [
  (a, p, d) => `Is the ${a} at ${p} on the ${d} still on track?`,
  (a, p, d) => `Are we good for the ${a} at ${p} on the ${d}?`,
];

const WEATHER_OK = [
  "The forecast is clear for the next 7 days.",
  "Rain is forecast for Thursday, so keep an eye on that window.",
  "Wind gusts over 30 mph are forecast Wednesday, which could stop crane picks.",
];

interface ScheduleState {
  behindDays: number;
  floatDays: number;
}

function scheduleSentence(
  activity: string,
  project: string,
  when: string,
  state: ScheduleState,
  rng: Rng,
): string {
  if (state.behindDays > 0) {
    return `The ${activity} at ${project} is ${state.behindDays} days behind: the forecast finish moved to ${when}, with no float left.`;
  }
  return chance(rng, 0.07)
    ? `You're right on track: the ${activity} at ${project} is planned for ${when}, with ${state.floatDays} days of float.`
    : `The ${activity} at ${project} is on track for ${when}, with ${state.floatDays} days of float.`;
}

export function scheduleStatus(ctx: TurnContext, opts: TurnOptions = {}): SiteTurnDraft {
  const { rng, memory } = ctx;
  if (!opts.reuse || !memory.activity) {
    memory.activity = pick(rng, SITE_ACTIVITIES);
    memory.date = chance(rng, 0.3) ? pick(rng, [9, 14, 16, 21]) : undefined;
  }
  const activity = memory.activity;
  const project = projectOf(ctx);
  const date = memory.date;
  const ask =
    opts.ask ??
    styled(
      rng,
      date !== undefined
        ? pick(rng, DATED_SCHEDULE_ASKS)(activity.name, project.name, ordinal(date))
        : pick(rng, SCHEDULE_ASKS)(activity.name, project.name),
    );
  const calls: SiteCall[] = [];
  const scheduleArgs = { project_id: project.id, activity: activity.name };
  const state: ScheduleState = chance(rng, 0.58)
    ? { behindDays: 0, floatDays: intBetween(rng, 2, 9) }
    : { behindDays: intBetween(rng, 2, 6), floatDays: 0 };
  const when =
    date !== undefined
      ? `the ${ordinal(date + state.behindDays)}`
      : pick(rng, ["Thursday", "next Tuesday", "the end of next week", "the 30th"]);
  const scheduleResult = {
    activity: activity.name,
    forecast_finish: when,
    float_days: state.floatDays,
    behind_days: state.behindDays,
  };
  if (chance(rng, 0.05)) {
    // A guessed project id that does not exist; the agent looks the project up and reads again.
    calls.push(
      resultFailed(
        ctx,
        "get_project_schedule",
        { project_id: project.id.replace(/\d$/, "0"), activity: activity.name },
        { ok: false, error: "project_not_found", status: 404 },
      ),
    );
    calls.push(ok(ctx, "list_projects", { status: "active" }, projectList()));
  }
  calls.push(ok(ctx, "get_project_schedule", scheduleArgs, scheduleResult));
  // Date slips: the agent reads the activity two days early.
  const slip = date !== undefined && !opts.reuse && chance(rng, 0.3);
  let reply = slip
    ? `The ${activity.name} at ${project.name} on the ${ordinal(date - 2)} is on track, with ${Math.max(state.floatDays, 2)} days of float.`
    : scheduleSentence(activity.name, project.name, when, state, rng);
  let failedCall: SiteCall | undefined;
  // Outdoor work is checked against the forecast; indoor work seldom is.
  if (chance(rng, activity.outdoor ? 0.85 : 0.1)) {
    const weatherArgs = { project_id: project.id, days: 7 };
    if (chance(rng, 0.06)) {
      failedCall = failed(ctx, "check_weather_delay", weatherArgs, {
        type: "502",
        message: "502 Bad Gateway: forecast provider unavailable",
      });
      calls.push(failedCall);
      reply += " I couldn't reach the forecast service, so weather risk isn't included.";
    } else {
      const weather = pick(rng, WEATHER_OK);
      calls.push(ok(ctx, "check_weather_delay", weatherArgs, { days: 7, outlook: weather }));
      reply += ` ${weather}`;
    }
  }
  if (slip) {
    memory.wrongDate = date - 2;
    return {
      kind: "schedule_status",
      topic: "schedule_status",
      ask,
      calls,
      reply,
      outcome: "answered",
      wrong: "date",
    };
  }
  return {
    kind: "schedule_status",
    topic: "schedule_status",
    ask,
    calls,
    reply,
    outcome: failedCall ? "failed" : "answered",
    ...(failedCall ? { failedCall } : {}),
  };
}

/* --- spec questions -------------------------------------------------------------- */

const SPEC_ASKS: ReadonlyArray<(item: string, project: string) => string> = [
  (i, p) => `What's the spec for the ${i} at ${p}?`,
  (i, p) => `What does the spec say about the ${i} at ${p}?`,
  (i, p) => `Check the spec book for the ${i} on ${p}.`,
  (i, p) => `What does the spec call for on the ${i} at ${p}?`,
];

export function specQuestion(ctx: TurnContext, opts: TurnOptions = {}): SiteTurnDraft {
  const { rng, memory } = ctx;
  if (!opts.reuse || !memory.spec) memory.spec = pick(rng, SITE_SPEC_ITEMS);
  const spec = memory.spec;
  const project = projectOf(ctx);
  const ask = opts.ask ?? styled(rng, pick(rng, SPEC_ASKS)(spec.ask, project.name));
  const calls: SiteCall[] = [
    ok(
      ctx,
      "get_project_info",
      { project_id: project.id },
      {
        id: project.id,
        name: project.name,
        architect: project.architect,
        documents: { spec_book: project.specBook, drawings: true, permits: true },
      },
    ),
  ];
  const base = { kind: "spec_question" as const, topic: "spec_question" as const, ask };
  const search = { project_id: project.id, query: spec.ask };
  if (!project.specBook) {
    if (chance(rng, 0.6)) calls.push(ok(ctx, "search_spec_book", search, { results: [] }));
    const reply = chance(rng, 0.75)
      ? `Actually, I don't have the spec book for ${project.name}, so I can't confirm the ${spec.ask}. ${project.architect} is the architect of record if you want to send an RFI.`
      : `There's no spec book on file for ${project.name}, so I can't confirm the ${spec.ask}.`;
    return { ...base, calls, reply, outcome: "failed" };
  }
  const found = { results: [{ section: spec.section, text: spec.answer }] };
  if (chance(rng, 0.05)) {
    const say = chance(rng, 0.5) ? "The spec search timed out. Let me try again." : undefined;
    calls.push(timedOut(ctx, "search_spec_book", search, 15_000, "Spec book search"));
    calls.push(ok(ctx, "search_spec_book", search, found, say));
  } else {
    calls.push(ok(ctx, "search_spec_book", search, found));
  }
  return {
    ...base,
    calls,
    reply: `Section ${spec.section} of the ${project.name} spec calls for ${spec.answer}.`,
    outcome: "answered",
  };
}

/* --- RFIs ---------------------------------------------------------------------------- */

const RFI_ASKS: ReadonlyArray<(rfi: string, subject: string, project: string) => string> = [
  (r, _s, p) => `What's the status of ${r} on ${p}?`,
  (r, _s, p) => `Has the architect answered ${r} for ${p}?`,
  (r) => `Who has the ball on ${r}?`,
  (r, s) => `Any update on ${r}, the ${s}?`,
  (r, _s, p) => `Is ${r} on ${p} answered yet?`,
];

const RFI_LIST_ASKS: ReadonlyArray<(project: string) => string> = [
  (p) => `Any open RFIs on ${p} that are past due?`,
  (p) => `Which RFIs are still open on ${p}?`,
];

function rfiNumber(rng: Rng): string {
  return `RFI-${String(intBetween(rng, 41, 118)).padStart(3, "0")}`;
}

export function rfiStatus(ctx: TurnContext, opts: TurnOptions = {}): SiteTurnDraft {
  const { rng, memory } = ctx;
  if (!opts.reuse || !memory.rfi) {
    memory.rfi = rfiNumber(rng);
    memory.rfiSubject = pick(rng, SITE_RFI_SUBJECTS);
  }
  const rfi = memory.rfi;
  const subject = memory.rfiSubject ?? SITE_RFI_SUBJECTS[0]!;
  const project = projectOf(ctx);
  const base = { kind: "rfis" as const, topic: "rfis" as const };
  if (!opts.reuse && chance(rng, 0.18)) {
    const ask = opts.ask ?? styled(rng, pick(rng, RFI_LIST_ASKS)(project.name));
    const overdue = intBetween(rng, 1, 4);
    const calls = [
      ok(
        ctx,
        "list_rfis",
        { project_id: project.id, status: "open" },
        {
          rfis: Array.from({ length: overdue + 3 }, (_, i) => ({
            number: `RFI-${80 + i}`,
            status: "open",
          })),
        },
      ),
    ];
    return {
      ...base,
      ask,
      calls,
      reply: `${overdue} open RFIs on ${project.name} are past due; the oldest is ${rfi}, the ${subject}, 6 days over with ${project.architect}.`,
      outcome: "answered",
    };
  }
  const ask = opts.ask ?? styled(rng, pick(rng, RFI_ASKS)(rfi, subject, project.name));
  const calls: SiteCall[] = [];
  if (chance(rng, 0.65))
    calls.push(
      ok(
        ctx,
        "list_rfis",
        { project_id: project.id, status: "all" },
        { rfis: [{ number: rfi, subject, status: "open" }] },
      ),
    );
  const getArgs = { project_id: project.id, rfi_number: rfi };
  if (chance(rng, 0.03)) {
    const missing = failed(ctx, "get_rfi", getArgs, {
      type: "404",
      message: `404 Not Found: no ${rfi} on ${project.id}`,
    });
    calls.push(missing);
    return {
      ...base,
      ask,
      calls,
      reply: `I couldn't find ${rfi} on ${project.name}. It may be logged under another number.`,
      outcome: "failed",
      failedCall: missing,
    };
  }
  // Now and then the agent reads the number with two digits swapped.
  const swapped = `RFI-${rfi[4]}${rfi[6]}${rfi[5]}`;
  if (!opts.reuse && swapped !== rfi && chance(rng, 0.07)) {
    const other = pick(
      rng,
      SITE_RFI_SUBJECTS.filter((s) => s !== subject),
    );
    memory.wrongRfi = swapped;
    calls.push(
      ok(
        ctx,
        "get_rfi",
        { project_id: project.id, rfi_number: swapped },
        { number: swapped, subject: other, status: "answered" },
      ),
    );
    return {
      ...base,
      ask,
      calls,
      reply: `${swapped}, the ${other}, was answered last week with a revised detail.`,
      outcome: "answered",
      wrong: "rfi",
    };
  }
  calls.push(
    ok(ctx, "get_rfi", getArgs, {
      number: rfi,
      subject,
      status: "open",
      ball_in_court: project.architect,
    }),
  );
  return {
    ...base,
    ask,
    calls,
    reply: rfiStateReply(rng, rfi, subject, project),
    outcome: "answered",
  };
}

function rfiStateReply(rng: Rng, rfi: string, subject: string, project: SiteProject): string {
  return pick(rng, [
    `${rfi}, the ${subject}, was answered by ${project.architect} on Tuesday: they sent a revised detail, SK-14.`,
    `${rfi}, the ${subject}, is still open with the structural engineer and due in 2 days.`,
    `${rfi}, the ${subject}, is 3 days overdue with ${project.architect}. The ball is in their court.`,
  ]);
}

const RFI_DRAFT_ASKS: ReadonlyArray<(subject: string, project: string) => string> = [
  (s, p) => `Draft an RFI to the architect about the ${s} at ${p}.`,
  (s, p) => `Write up an RFI for the ${s} on ${p}.`,
];

const RFI_DRAFT_FOLLOW_UPS = [
  "Can you draft an RFI to the architect about that?",
  "Draft an RFI for it.",
  "Write that up as an RFI to the architect.",
];

/** An RFI drafted on its own, or right after a spec question or an RFI the user asked about. */
export function rfiDraft(ctx: TurnContext, after: SiteTurnKind | null): SiteTurnDraft {
  const { rng, memory } = ctx;
  const project = projectOf(ctx);
  const followUp = after === "spec_question" || after === "rfis";
  if (!followUp || !memory.rfiSubject) memory.rfiSubject = pick(rng, SITE_RFI_SUBJECTS);
  const subject = after === "spec_question" && memory.spec ? memory.spec.ask : memory.rfiSubject;
  const ask = followUp
    ? pick(rng, RFI_DRAFT_FOLLOW_UPS)
    : styled(rng, pick(rng, RFI_DRAFT_ASKS)(subject, project.name));
  const number = rfiNumber(rng);
  const args = {
    project_id: project.id,
    subject,
    question: `Please confirm the ${subject}.`,
    to: project.architect,
    discipline: "",
  };
  const calls: SiteCall[] = [];
  if (chance(rng, 0.2)) {
    calls.push(
      failed(ctx, "create_rfi", args, {
        type: "422",
        message: "422 Unprocessable Entity: discipline is required",
      }),
    );
    const discipline = pick(rng, ["Structural", "Architectural", "Mechanical"]);
    const say = chance(rng, 0.6)
      ? `The RFI form needs a discipline. Let me retry with ${discipline}.`
      : undefined;
    calls.push(ok(ctx, "create_rfi", { ...args, discipline }, { number, status: "draft" }, say));
  } else {
    calls.push(
      ok(ctx, "create_rfi", { ...args, discipline: "Architectural" }, { number, status: "draft" }),
    );
  }
  return {
    kind: "rfi_draft",
    topic: "rfis",
    ask,
    calls,
    reply: `Drafted ${number} to ${project.architect} about the ${subject}. It's saved for your review before it goes out.`,
    outcome: "answered",
  };
}

/* --- change orders ---------------------------------------------------------------- */

const CO_ASKS: ReadonlyArray<(scope: string, co: string, project: string) => string> = [
  (s, _c, p) => `Estimate a change order for ${s} at ${p}.`,
  (s, _c, p) => `What would ${s} cost at ${p}? Need a CO estimate.`,
  (_s, c, p) => `Price out ${c} for ${p}.`,
  (s, _c, p) => `Can you run a CO estimate for ${s} on ${p}?`,
];

function estimate(
  rng: Rng,
  total: number,
): { total: number; labor: number; material: number; days: number } {
  const labor = total * between(rng, 0.4, 0.6);
  return { total, labor, material: total - labor, days: Math.max(2, Math.round(total / 6_000)) };
}

function estimateSentence(co: string, scope: string, e: ReturnType<typeof estimate>): string {
  return `${co} for ${scope} comes to about ${dollars(e.total)}: ${dollars(e.labor)} labor and ${dollars(e.material)} material, ${e.days} working days.`;
}

export function changeOrder(ctx: TurnContext, opts: TurnOptions = {}): SiteTurnDraft {
  const { rng, memory } = ctx;
  if (!opts.reuse || !memory.co) {
    memory.co = `CO-${String(intBetween(rng, 14, 58)).padStart(3, "0")}`;
    memory.scope = pick(rng, SITE_CHANGE_SCOPES);
    memory.total = Math.round(between(rng, 8_000, 120_000));
  }
  const co = memory.co;
  const scope = memory.scope ?? SITE_CHANGE_SCOPES[0]!;
  const project = projectOf(ctx);
  const ask = opts.ask ?? styled(rng, pick(rng, CO_ASKS)(scope, co, project.name));
  // Now and then the estimate runs on last year's unit rates.
  const slip = !opts.reuse && chance(rng, 0.08);
  const e = estimate(rng, (memory.total ?? 40_000) * (slip ? 0.88 : 1));
  const estimateArgs = {
    project_id: project.id,
    co_number: co,
    scope,
    labor_days: e.days,
    unit_rate_year: slip ? 2025 : 2026,
  };
  const calls: SiteCall[] = [
    ok(
      ctx,
      "get_change_order",
      { project_id: project.id, co_number: co },
      { co_number: co, scope, status: "pending pricing" },
    ),
  ];
  const priced = {
    total: Math.round(e.total),
    labor: Math.round(e.labor),
    material: Math.round(e.material),
    working_days: e.days,
  };
  if (chance(rng, 0.04)) {
    calls.push(
      failed(ctx, "estimate_change_order", estimateArgs, {
        type: "500",
        message: "500 Internal Server Error: rate table lookup failed",
      }),
    );
    calls.push(
      ok(
        ctx,
        "estimate_change_order",
        estimateArgs,
        priced,
        chance(rng, 0.5) ? "The estimator errored out. Let me try that again." : undefined,
      ),
    );
  } else {
    calls.push(ok(ctx, "estimate_change_order", estimateArgs, priced));
  }
  const hedge = chance(rng, 0.06) ? " Let me know if I made a mistake in the quantities." : "";
  return {
    kind: "change_orders",
    topic: "change_orders",
    ask,
    calls,
    reply: estimateSentence(co, scope, e) + hedge,
    outcome: "answered",
    ...(slip ? { wrong: "rates" as const } : {}),
  };
}

const CO_REFINE_ASKS: ReadonlyArray<(co: string, days: number) => string> = [
  (_c, d) => `Refine the change order: use ${d} days of labor instead.`,
  (c) => `Can you redo ${c} with weekend overtime?`,
  (c) => `Take out the contingency and re-run the ${c} estimate.`,
  (c) => `Refine ${c}: add a second crew and see what it costs.`,
];

export function changeOrderRefine(ctx: TurnContext): SiteTurnDraft {
  const { rng, memory } = ctx;
  const project = projectOf(ctx);
  const co = memory.co ?? "CO-021";
  const scope = memory.scope ?? SITE_CHANGE_SCOPES[0]!;
  const days = intBetween(rng, 3, 12);
  const ask = pick(rng, CO_REFINE_ASKS)(co, days);
  memory.total = Math.round((memory.total ?? 40_000) * between(rng, 0.85, 1.25));
  const e = estimate(rng, memory.total);
  const calls = [
    ok(
      ctx,
      "estimate_change_order",
      { project_id: project.id, co_number: co, scope, labor_days: days, unit_rate_year: 2026 },
      { total: Math.round(e.total), working_days: e.days },
    ),
  ];
  const reply = chance(rng, 0.07)
    ? `I made a mistake in the first estimate: I left out the general conditions. With them and your change, ${co} comes to about ${dollars(e.total)}.`
    : `Updated ${co}: about ${dollars(e.total)} with that change, ${e.days} working days.`;
  return {
    kind: "change_order_refine",
    topic: "change_orders",
    ask,
    calls,
    reply,
    outcome: "answered",
  };
}

/* --- payment status ---------------------------------------------------------------- */

const PAYMENT_ASKS: ReadonlyArray<(project: string, payApp: number) => string> = [
  (p) => `Is the owner payment for ${p} for last month received?`,
  (p, n) => `Has pay app #${n} for ${p} been paid yet?`,
  (p) => `What's the status of our pay application on ${p}?`,
  (p) => `When is the owner payment for ${p} due?`,
];

export function paymentStatus(ctx: TurnContext, opts: TurnOptions = {}): SiteTurnDraft {
  const { rng, memory } = ctx;
  if (!opts.reuse || memory.payApp === undefined) memory.payApp = intBetween(rng, 7, 19);
  const payApp = memory.payApp;
  const project = projectOf(ctx);
  const base = { kind: "payment_status" as const, topic: "payment_status" as const };
  if (!opts.reuse && chance(rng, 0.18)) {
    const material = pick(rng, SITE_MATERIALS);
    const invoice = `INV-${intBetween(rng, 40_210, 48_990)}`;
    const ask = opts.ask ?? `Did ${material.supplier} get paid for invoice ${invoice}?`;
    const calls = [
      ok(
        ctx,
        "check_payment_status",
        { invoice_number: invoice },
        { status: "paid", paid: "last Friday" },
      ),
    ];
    return {
      ...base,
      ask,
      calls,
      reply: `Yes, ${material.supplier} invoice ${invoice} was paid last Friday by ACH.`,
      outcome: "answered",
    };
  }
  const ask = opts.ask ?? styled(rng, pick(rng, PAYMENT_ASKS)(project.name, payApp));
  const billed = Math.round(between(rng, 180_000, 1_400_000));
  const payAppId = `${project.id}-PA${payApp}`;
  const calls: SiteCall[] = [
    ok(
      ctx,
      "get_pay_application",
      { project_id: project.id, period: "last_month" },
      { pay_app_id: payAppId, billed, retainage: Math.round(billed * 0.05), status: "approved" },
    ),
  ];
  const statusArgs = { pay_app_id: payAppId };
  const outcomes = [
    `Pay app #${payApp} for ${project.name} (${dollars(billed)}) was paid on the 3rd.`,
    `Pay app #${payApp} for ${project.name} (${dollars(billed)}) is approved by the owner; payment is expected in 5 days.`,
    `Pay app #${payApp} for ${project.name} (${dollars(billed)}) is still with the owner's rep for review.`,
  ];
  const settled = { status: "approved", expected: "in 5 days" };
  if (chance(rng, 0.08)) {
    const first = timedOut(
      ctx,
      "check_payment_status",
      statusArgs,
      20_000,
      "Accounting system request",
    );
    calls.push(first);
    if (chance(rng, 0.6)) {
      const say = chance(rng, 0.5)
        ? "The accounting system timed out. Let me try that again."
        : undefined;
      if (chance(rng, 0.75)) {
        calls.push(ok(ctx, "check_payment_status", statusArgs, settled, say));
        return { ...base, ask, calls, reply: pick(rng, outcomes), outcome: "answered" };
      }
      const second = timedOut(
        ctx,
        "check_payment_status",
        statusArgs,
        20_000,
        "Accounting system request",
        say,
      );
      calls.push(second);
      return {
        ...base,
        ask,
        calls,
        reply: `I'm sorry, the accounting system isn't responding, so I can't confirm whether pay app #${payApp} was paid.`,
        outcome: "failed",
        failedCall: second,
      };
    }
    return {
      ...base,
      ask,
      calls,
      reply: `The accounting system timed out, so I can't confirm whether pay app #${payApp} was paid yet.`,
      outcome: "failed",
      failedCall: first,
    };
  }
  calls.push(ok(ctx, "check_payment_status", statusArgs, settled));
  return { ...base, ask, calls, reply: pick(rng, outcomes), outcome: "answered" };
}

export function retainage(ctx: TurnContext): SiteTurnDraft {
  const { rng } = ctx;
  const project = projectOf(ctx);
  const held = Math.round(between(rng, 60_000, 420_000));
  const ask = pick(rng, [
    `How much retainage is being held on ${project.name}?`,
    "What's the retainage on that job right now?",
    "And how much retainage are they holding?",
  ]);
  const calls = [
    ok(
      ctx,
      "get_pay_application",
      { project_id: project.id, period: "to_date" },
      { retainage_held: held },
    ),
  ];
  return {
    kind: "retainage",
    topic: "payment_status",
    ask,
    calls,
    reply: `${dollars(held)} of retainage is held on ${project.name} to date, 5 percent of the work billed.`,
    outcome: "answered",
  };
}

/* --- subcontractors ------------------------------------------------------------------ */

const SUB_ASKS: ReadonlyArray<(sub: SiteSub, project: string) => string> = [
  (s, p) => `Is ${s.company}'s insurance certificate current for ${p}?`,
  (s, p) => `Has ${s.company} finished site safety orientation at ${p}?`,
  (s, p) => `Is ${s.company} compliant to start work at ${p} Monday?`,
];

export function subcontractors(ctx: TurnContext, opts: TurnOptions = {}): SiteTurnDraft {
  const { rng, memory } = ctx;
  if (!opts.reuse || !memory.sub) memory.sub = pick(rng, SITE_SUBS);
  const sub = memory.sub;
  const project = projectOf(ctx);
  const base = { kind: "subcontractors" as const, topic: "subcontractors" as const };
  const listArgs = { project_id: project.id, trade: sub.trade };
  const listed = {
    subcontractors: [
      {
        id: `SUB-${sub.company.length * 37}`,
        company: sub.company,
        trade: sub.trade,
        foreman: sub.foreman,
        phone: sub.phone,
      },
    ],
  };
  if (!opts.reuse && chance(rng, 0.3)) {
    const ask =
      opts.ask ??
      styled(
        rng,
        `Who's the ${sub.trade} sub on ${project.name} and how do I reach their foreman?`,
      );
    return {
      ...base,
      ask,
      calls: [ok(ctx, "list_subcontractors", listArgs, listed)],
      reply: `${sub.company} has the ${sub.trade} scope on ${project.name}. Their foreman is ${sub.foreman}, ${sub.phone}.`,
      outcome: "answered",
    };
  }
  const ask = opts.ask ?? styled(rng, pick(rng, SUB_ASKS)(sub, project.name));
  const calls: SiteCall[] = [ok(ctx, "list_subcontractors", listArgs, listed)];
  const complianceArgs = {
    project_id: project.id,
    subcontractor_id: `SUB-${sub.company.length * 37}`,
  };
  const done = intBetween(rng, 9, 16);
  const answer = chance(rng, 0.75)
    ? `${sub.company}'s certificate of insurance is current through March, and ${done} of 16 crew have finished site orientation at ${project.name}.`
    : `${sub.company}'s certificate of insurance expired last week, so they can't start at ${project.name} until a new one is uploaded.`;
  if (chance(rng, 0.1)) {
    const first = failed(ctx, "get_subcontractor_compliance", complianceArgs, {
      type: "500",
      message: "500 Internal Server Error: compliance service error",
    });
    calls.push(first);
    if (chance(rng, 0.4)) {
      calls.push(
        ok(ctx, "get_subcontractor_compliance", complianceArgs, {
          coi: "current",
          orientation_done: done,
        }),
      );
      return { ...base, ask, calls, reply: answer, outcome: "answered" };
    }
    return {
      ...base,
      ask,
      calls,
      reply: `I couldn't reach the compliance system, so I can't confirm ${sub.company}'s certificate right now.`,
      outcome: "failed",
      failedCall: first,
    };
  }
  calls.push(
    ok(ctx, "get_subcontractor_compliance", complianceArgs, {
      coi: "current",
      orientation_done: done,
    }),
  );
  return { ...base, ask, calls, reply: answer, outcome: "answered" };
}

/* --- safety ------------------------------------------------------------------------- */

const INCIDENT_ASKS: ReadonlyArray<(incident: string, project: string) => string> = [
  (i, p) => `Need to report a safety incident at ${p}: near miss, ${i}.`,
  (i, p) => `Log a near miss at ${p}: ${i}.`,
  (i, p) => `Report a near miss on ${p}, ${i}.`,
];

export function safetyReport(ctx: TurnContext, opts: TurnOptions = {}): SiteTurnDraft {
  const { rng } = ctx;
  if (!opts.reuse && chance(rng, 0.35)) return safetyChecklist(ctx, false);
  const project = projectOf(ctx);
  const incident = pick(rng, SITE_INCIDENTS);
  const ask = opts.ask ?? pick(rng, INCIDENT_ASKS)(incident, project.name);
  const id = `SI-${intBetween(rng, 310, 489)}`;
  const args = { project_id: project.id, type: "near_miss", description: incident, location: "" };
  const calls: SiteCall[] = [];
  if (chance(rng, 0.06)) {
    calls.push(
      failed(ctx, "log_safety_incident", args, {
        type: "400",
        message: "400 Bad Request: location is required",
      }),
    );
    const location = pick(rng, [
      "level 3, grid C-4",
      "the north laydown yard",
      "the east stair tower",
      "the roof, north side",
    ]);
    calls.push(
      ok(
        ctx,
        "log_safety_incident",
        { ...args, location },
        { incident_id: id, status: "logged" },
        chance(rng, 0.6)
          ? `The incident form needs a location. Let me try again with ${location}.`
          : undefined,
      ),
    );
  } else {
    calls.push(
      ok(
        ctx,
        "log_safety_incident",
        { ...args, location: "per report" },
        { incident_id: id, status: "logged" },
      ),
    );
  }
  calls.push(
    ok(
      ctx,
      "notify_team",
      { project_id: project.id, channel: "safety", message: `Near miss logged as ${id}` },
      { posted: true, channel: "safety" },
    ),
  );
  return {
    kind: "safety_report",
    topic: "safety_report",
    ask,
    calls,
    reply: `Logged it as ${id} at ${project.name} and notified the safety manager.`,
    outcome: "answered",
  };
}

const CHECKLISTS: Record<string, string> = {
  "crane lift":
    "the lift plan signed, the rigger and signal person named, outriggers on mats, and the swing radius barricaded",
  excavation:
    "the competent person's daily inspection, the sloping or shoring plan, utilities located, and a ladder every 25 feet",
  "hot work":
    "the hot work permit, a fire watch for 30 minutes after, an extinguisher within 10 feet, and combustibles cleared",
  "confined space entry":
    "the entry permit, atmospheric testing before entry, an attendant outside, and the rescue plan",
  "steel erection":
    "fall protection tie-off above 15 feet, the erection sequence reviewed, and controlled decking zones marked",
};

export function safetyChecklist(ctx: TurnContext, followUp: boolean): SiteTurnDraft {
  const { rng } = ctx;
  const project = projectOf(ctx);
  const task = pick(rng, SITE_CHECKLIST_TASKS);
  const ask = followUp
    ? pick(rng, [
        `Give me the checklist for the ${task} tomorrow too.`,
        `What's on the checklist for ${task}?`,
      ])
    : styled(
        rng,
        pick(rng, [
          `Give me the safety checklist for the ${task} tomorrow at ${project.name}.`,
          `What's on the checklist for ${task}?`,
          `Pull the pre-task checklist for the ${task} at ${project.name}.`,
        ]),
      );
  const calls = [ok(ctx, "get_safety_checklist", { activity: task }, { activity: task, items: 4 })];
  return {
    kind: followUp ? "safety_checklist" : "safety_report",
    topic: "safety_report",
    ask,
    calls,
    reply: `For a ${task} you need ${CHECKLISTS[task]}.`,
    outcome: "answered",
  };
}

/* --- requests no tool handles --------------------------------------------------------- */

const RENTAL_ASKS: ReadonlyArray<(equipment: string, project: string, activity: string) => string> =
  [
    (e, p) => `Book a ${e} rental for ${p} starting Monday for two weeks.`,
    (e, p) => `Can you get a ${e} to ${p} for 3 days next week?`,
    (e, p) => `I need a ${e} on site at ${p} Thursday. Can you set up the rental?`,
    (e, p) => `Rent a ${e} for ${p} through the end of the month.`,
    (e, p) => `Extend the ${e} rental at ${p} by another week.`,
    (e, p, a) => `Order a ${e} for ${p}, we need it for the ${a}.`,
  ];

export function equipmentRental(ctx: TurnContext, opts: TurnOptions = {}): SiteTurnDraft {
  const { rng, memory } = ctx;
  if (!opts.reuse || !memory.equipment) memory.equipment = pick(rng, SITE_EQUIPMENT);
  const equipment = memory.equipment;
  const project = projectOf(ctx);
  const ask =
    opts.ask ??
    styled(rng, pick(rng, RENTAL_ASKS)(equipment, project.name, pick(rng, SITE_ACTIVITIES).name));
  const r = rng();
  const calls: SiteCall[] =
    r < 0.72
      ? [
          ok(
            ctx,
            "get_project_info",
            { project_id: project.id },
            { id: project.id, name: project.name, gate_hours: "6am to 4pm" },
          ),
        ]
      : r < 0.88
        ? [ok(ctx, "list_projects", { status: "active" }, projectList())]
        : [];
  const replies = [
    `I can't book equipment rentals: there's no rental tool connected to Site Copilot. Rental requests for ${project.name} go through ${project.equipmentDesk}.`,
    `I'm sorry, but I can't place rental orders. The site's gate hours are 6am to 4pm if the rental desk asks, and ${project.equipmentDesk} handles equipment for ${project.name}.`,
    `Booking rentals isn't something I can do yet. ${project.equipmentDesk} handles equipment for ${project.name}.`,
  ];
  return {
    kind: "equipment_rental",
    topic: "equipment_rental",
    ask,
    calls,
    reply: pick(rng, replies),
    outcome: "unanswerable",
  };
}

const INSPECTION_ASKS: ReadonlyArray<
  (inspection: string, project: string, date: string) => string
> = [
  (i, p) => `Schedule a site inspection with the city for ${i} at ${p} on Friday morning.`,
  (i, p, d) => `Book the ${i} inspection at ${p} for the ${d}.`,
  (i, p) => `Can you get the city out to ${p} for the ${i} inspection this week?`,
  (i, p) => `Request a third-party inspection for ${i} at ${p} tomorrow.`,
  (i, p) => `Set up the ${i} inspection at ${p}, any time Thursday works.`,
];

export function inspectionBooking(ctx: TurnContext, opts: TurnOptions = {}): SiteTurnDraft {
  const { rng, memory } = ctx;
  if (!opts.reuse || !memory.inspection) memory.inspection = pick(rng, SITE_INSPECTIONS);
  const inspection = memory.inspection;
  const project = projectOf(ctx);
  const ask =
    opts.ask ??
    styled(
      rng,
      pick(rng, INSPECTION_ASKS)(inspection, project.name, ordinal(pick(rng, [14, 21, 28]))),
    );
  const r = rng();
  const calls: SiteCall[] =
    r < 0.6
      ? [
          ok(
            ctx,
            "get_project_schedule",
            { project_id: project.id, activity: `${inspection} inspection` },
            { activity: `${inspection} inspection`, forecast_finish: "next week" },
          ),
        ]
      : r < 0.86
        ? [
            ok(
              ctx,
              "get_project_info",
              { project_id: project.id },
              { id: project.id, name: project.name, permit: "BP-2026-0412" },
            ),
          ]
        : [];
  const replies = [
    `I can't book inspections with the city or third-party agencies. The ${project.name} schedule shows the ${inspection} inspection next week, so the request should go in by Thursday.`,
    `I'm sorry, but I can't schedule inspections. The ${inspection} inspection at ${project.name} has to be requested through the city's permit portal under permit BP-2026-0412.`,
    `Scheduling inspections isn't connected to Site Copilot yet. The ${inspection} inspection at ${project.name} needs a request through the permit portal.`,
  ];
  return {
    kind: "inspection_booking",
    topic: "inspection_booking",
    ask,
    calls,
    reply: pick(rng, replies),
    outcome: "unanswerable",
  };
}

/** After a request no tool handles: the user asks to at least pass it on. */
export function handoff(ctx: TurnContext, topic: SiteTopicId): SiteTurnDraft {
  const { rng, memory } = ctx;
  const project = projectOf(ctx);
  const what =
    topic === "equipment_rental"
      ? `${memory.equipment ?? "equipment"} request`
      : `${memory.inspection ?? "inspection"} inspection request`;
  const ask = pick(rng, [
    `Can you at least send the request to ${project.equipmentDesk}?`,
    `Then post it in ${project.channel} so someone books it.`,
    "Fine, just pass it on to whoever handles it.",
  ]);
  const calls = [
    ok(
      ctx,
      "notify_team",
      { project_id: project.id, channel: project.channel, message: `New ${what}` },
      { posted: true, channel: project.channel },
    ),
  ];
  return {
    kind: "handoff",
    topic,
    ask,
    calls,
    reply: `Posted your ${what} for ${project.name} in ${project.channel}.`,
    outcome: "answered",
  };
}

/* --- follow-ups ------------------------------------------------------------------------ */

const SCHEDULE_IMPACT_ASKS: ReadonlyArray<(co: string, activity: string) => string> = [
  (c) => `What's the schedule impact if we approve ${c}?`,
  (c, a) => `Does ${c} push the ${a}?`,
  () => "How does that hit the schedule?",
];

export function scheduleImpact(ctx: TurnContext, after: SiteTurnKind): SiteTurnDraft {
  const { rng, memory } = ctx;
  const project = projectOf(ctx);
  memory.activity ??= pick(rng, SITE_ACTIVITIES);
  const activity = memory.activity.name;
  const ask =
    after === "material_delivery"
      ? pick(rng, [`Will that delay the ${activity}?`, `Does that push the ${activity}?`])
      : pick(rng, SCHEDULE_IMPACT_ASKS)(memory.co ?? "the change order", activity);
  const float = intBetween(rng, 0, 6);
  const calls = [
    ok(
      ctx,
      "get_project_schedule",
      { project_id: project.id, activity },
      { activity, float_days: float },
    ),
  ];
  const reply =
    float >= 3
      ? `The ${activity} has ${float} days of float, so it absorbs that without moving the finish.`
      : `The ${activity} has ${float} days of float, so it would push the finish by about ${3 - float} days.`;
  return {
    kind: "schedule_impact",
    topic: "schedule_status",
    ask,
    calls,
    reply,
    outcome: "answered",
  };
}

export function weatherRisk(ctx: TurnContext): SiteTurnDraft {
  const { rng, memory } = ctx;
  const project = projectOf(ctx);
  const activity = memory.activity?.name ?? "site paving";
  const ask = pick(rng, [
    `What about weather risk for the ${activity} this week?`,
    `Any weather risk this week at ${project.name}?`,
  ]);
  const outlook = pick(rng, WEATHER_OK);
  const calls = [
    ok(ctx, "check_weather_delay", { project_id: project.id, days: 7 }, { days: 7, outlook }),
  ];
  return {
    kind: "weather_risk",
    topic: "schedule_status",
    ask,
    calls,
    reply: outlook,
    outcome: "answered",
  };
}

const TRY_AGAIN_ASKS = [
  "Can you try again?",
  "Try again?",
  "Can you check again?",
  "Still nothing? Try once more.",
  "Can you try that again?",
  "try again please",
];

interface RetryReplies {
  ok: string;
  failed: string;
  /** What the tool returns when the retry works. */
  result: unknown;
}

/** Replies once a retried call works, and when it fails again, by tool. */
const RETRY_REPLIES: Partial<Record<SiteToolId, (ctx: TurnContext) => RetryReplies>> = {
  track_material_delivery: (ctx) => {
    const material = ctx.memory.material ?? SITE_MATERIALS[0]!;
    const po = poNumberOf(material, ctx.memory.projectIndex);
    const state = pick(ctx.rng, DELIVERY_STATES);
    return {
      ok: deliveryReply(po, material, projectOf(ctx), state),
      failed: `I'm sorry, the supplier tracking service still isn't responding. ${po} was promised for ${ctx.memory.promised ?? "this week"}, and I'll have the status once the service is back.`,
      result: { po_number: po, status: state.status },
    };
  },
  check_payment_status: (ctx) => ({
    ok: `Pay app #${ctx.memory.payApp ?? 12} for ${projectOf(ctx).name} is approved by the owner; payment is expected in 5 days.`,
    failed: `The accounting system is still timing out, so I can't confirm pay app #${ctx.memory.payApp ?? 12} yet.`,
    result: { status: "approved", expected: "in 5 days" },
  }),
  get_subcontractor_compliance: (ctx) => ({
    ok: `${ctx.memory.sub?.company ?? "The sub"}'s certificate of insurance is current through March.`,
    failed: `The compliance system is still down, so I can't confirm ${ctx.memory.sub?.company ?? "their"} certificate yet.`,
    result: { coi: "current" },
  }),
  check_weather_delay: (ctx) => {
    const outlook = pick(ctx.rng, WEATHER_OK);
    return {
      ok: outlook,
      failed: "The forecast service is still unavailable.",
      result: { days: 7, outlook },
    };
  },
  get_rfi: (ctx) => ({
    ok: `${ctx.memory.rfi ?? "The RFI"} is still open with the architect.`,
    failed: `There's still no ${ctx.memory.rfi ?? "RFI"} on ${projectOf(ctx).name}.`,
    result: { number: ctx.memory.rfi, status: "open" },
  }),
};

/** Whether a "Can you try again?" can follow a turn that ended on this call. */
export const retryable = (call: SiteCall | undefined): boolean =>
  call !== undefined && RETRY_REPLIES[call.tool] !== undefined;

export function tryAgain(ctx: TurnContext, last: SiteTurnDraft, failures: number): SiteTurnDraft {
  const { rng } = ctx;
  const call = last.failedCall!;
  const ask =
    failures >= 2 && chance(rng, 0.5)
      ? "This is the third time it failed. Try again?"
      : pick(rng, TRY_AGAIN_ASKS);
  const replies = RETRY_REPLIES[call.tool]!(ctx);
  const works = chance(
    rng,
    call.tool === "get_rfi" ? 0 : call.tool === "track_material_delivery" ? 0.55 : 0.7,
  );
  const base = { kind: "try_again" as const, topic: last.topic, ask };
  if (works) {
    const lead = chance(rng, 0.5) ? "Sorry about that, it came through this time. " : "";
    return {
      ...base,
      calls: [again(call, ok(ctx, call.tool, call.args, replies.result))],
      reply: lead + replies.ok,
      outcome: "answered",
    };
  }
  const retried =
    call.tool === "track_material_delivery"
      ? trackFailure(ctx, call.args)
      : {
          ...call,
          tookMs: call.errorType === "timeout" ? call.tookMs : Math.round(between(rng, 90, 420)),
        };
  return {
    ...base,
    calls: [retried],
    reply: replies.failed,
    outcome: "failed",
    failedCall: retried,
  };
}

/** The user who catches a wrong answer, and the agent who owns it. */
export function correction(ctx: TurnContext, last: SiteTurnDraft): SiteTurnDraft {
  const { rng, memory } = ctx;
  const project = projectOf(ctx);
  const base = { kind: "correction" as const, topic: last.topic };
  if (last.wrong === "date") {
    const activity = memory.activity?.name ?? "pour";
    const date = ordinal(memory.date ?? 14);
    const wrongDate = ordinal(memory.wrongDate ?? 12);
    const ask = pick(rng, [
      `That's not right, it's on the ${date}, not the ${wrongDate}.`,
      `No, that's the wrong date. The ${activity} is on the ${date}.`,
    ]);
    const float = intBetween(rng, 1, 5);
    const calls = [
      ok(
        ctx,
        "get_project_schedule",
        { project_id: project.id, activity, date },
        { activity, float_days: float },
      ),
    ];
    return {
      ...base,
      ask,
      calls,
      reply: `You're absolutely right, I used the wrong date. The ${activity} on the ${date} is on track, with ${float} days of float.`,
      outcome: "answered",
    };
  }
  if (last.wrong === "rfi") {
    const rfi = memory.rfi ?? "RFI-072";
    const swapped = memory.wrongRfi ?? "RFI-027";
    const subject = memory.rfiSubject ?? SITE_RFI_SUBJECTS[0]!;
    const ask = pick(rng, [
      `That's not right, I asked about ${rfi}.`,
      `That's ${swapped}, I meant ${rfi}.`,
    ]);
    const calls = [
      ok(
        ctx,
        "get_rfi",
        { project_id: project.id, rfi_number: rfi },
        { number: rfi, subject, status: "open" },
      ),
    ];
    return {
      ...base,
      ask,
      calls,
      reply: `My mistake, I read ${swapped} instead of ${rfi}. ${rfiStateReply(rng, rfi, subject, project)}`,
      outcome: "answered",
    };
  }
  if (last.wrong === "rates") {
    const co = memory.co ?? "CO-021";
    const ask = pick(rng, [
      "That's not right, labor should be at this year's rates.",
      "Those look like last year's labor rates. Can you fix that?",
    ]);
    const total = memory.total ?? 40_000;
    const calls = [
      ok(
        ctx,
        "estimate_change_order",
        { project_id: project.id, co_number: co, scope: memory.scope ?? "", unit_rate_year: 2026 },
        { total },
      ),
    ];
    return {
      ...base,
      ask,
      calls,
      reply: `You're right, I used last year's unit rates. At this year's rates ${co} comes to about ${dollars(total)}.`,
      outcome: "answered",
    };
  }
  const wrong = SITE_PROJECTS[memory.wrongProjectIndex ?? 0]!;
  const material = memory.material ?? SITE_MATERIALS[0]!;
  const po = poNumberOf(material, memory.projectIndex);
  const ask = pick(rng, [
    `That's the wrong project, I meant ${project.name}.`,
    `That's not right, I asked about ${project.name}, not ${wrong.name}.`,
  ]);
  const state = pick(rng, DELIVERY_STATES);
  const calls = [
    ok(
      ctx,
      "get_purchase_order",
      { project_id: project.id, material: material.name },
      { po_number: po, supplier: material.supplier, items: [material.name] },
    ),
    ok(ctx, "track_material_delivery", { po_number: po }, { po_number: po, status: state.status }),
  ];
  return {
    ...base,
    ask,
    calls,
    reply: `My mistake, I pulled ${wrong.name} instead of ${project.name}. ${deliveryReply(po, material, project, state)}`,
    outcome: "answered",
  };
}

const THANKS = [
  "Thanks, perfect",
  "Great, thanks",
  "Perfect, thank you",
  "Thanks, that's what I needed",
  "ok thanks",
  "Thanks!",
];

export function thanks(ctx: TurnContext): SiteTurnDraft {
  const { rng } = ctx;
  const project = projectOf(ctx);
  if (chance(rng, 0.38)) {
    const ask = `${pick(rng, ["Thanks, perfect.", "Great, thanks."])} Can you post that in ${project.channel}?`;
    const calls = [
      ok(
        ctx,
        "notify_team",
        {
          project_id: project.id,
          channel: project.channel,
          message: "Status update from Site Copilot",
        },
        { posted: true, channel: project.channel },
      ),
    ];
    return {
      kind: "thanks",
      topic: null,
      ask,
      calls,
      reply: `Posted it in ${project.channel}.`,
      outcome: "closing",
    };
  }
  return {
    kind: "thanks",
    topic: null,
    ask: pick(rng, THANKS),
    calls: [],
    reply: pick(rng, ["You're welcome.", "Glad that helped.", "Anytime."]),
    outcome: "closing",
  };
}

/** The same ask again: resent as it was, or close to it. */
export function restate(rng: Rng, ask: string): string {
  const r = rng();
  if (r < 0.55) return ask;
  if (r < 0.75) return ask.toLowerCase().replace(/[?.]$/, "");
  return `${ask.replace(/[?.]$/, "")}?? It's urgent.`;
}
