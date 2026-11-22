import { type SetupGuide, setupGuides } from "@/components/console/health/setup-guides";
import { formatSharePercent } from "@/lib/readings/trace-signals/claims";
import type {
  SetupFact,
  SetupKey,
  SetupStatus,
  StoredSetup,
} from "@/lib/readings/trace-signals/setup-facts";

/**
 * The setup card's model: what the project sends, data point by data point
 * (`summary.setup`), as pills to act on. Pure, so the card only lays it out.
 *
 * The card shows on every page load while anything is missing. Dismissing it
 * hides it for that page view only: the state lives in React and nothing is
 * stored, so it is back on the next load ({@link setupCardReducer}).
 */

export type SetupSource = "otel" | "sdk";

/** Pill colours: green received, amber partly sent, coral not sent. */
export type SetupTone = "green" | "amber" | "coral";

const TONE: Readonly<Record<SetupStatus, SetupTone>> = {
  on: "green",
  partial: "amber",
  off: "coral",
};

interface FactCopy {
  /** The chip's short name. */
  label: string;
  /** What turning it on adds, as one line. */
  unlocks: string;
}

const COPY: Readonly<Record<SetupKey, FactCopy>> = {
  otel_tool_spans: {
    label: "Tool spans",
    unlocks: "Everything on this page starts from tool calls.",
  },
  otel_model_calls: { label: "Model spans", unlocks: "Model calls per run, and tokens." },
  otel_conversation_id: {
    label: "Conversation id",
    unlocks: "What each tool needs first, across runs of one conversation.",
  },
  otel_user_id: { label: "User id", unlocks: "Patterns per user." },
  otel_content: {
    label: "Content",
    unlocks: "Empty results, and the ask text behind task names and missing tools.",
  },
  otel_tool_definitions: {
    label: "Tool definitions",
    unlocks: "Tools offered to the model but never used.",
  },
  otel_trace_context: {
    label: "One trace per request",
    unlocks:
      "Each tool call arrives as its own trace, so one ask is not one run and tasks cannot form.",
  },
  sdk_tool_calls: {
    label: "Tool calls",
    unlocks: "Run shapes, tasks and what comes before each tool all start from tool calls.",
  },
  sdk_search_queries: {
    label: "Search queries",
    unlocks: "Search quality, and requests no tool handles.",
  },
  sdk_turn_ids: {
    label: "Turn ids",
    unlocks: "Exact run boundaries instead of guesses from 90-second gaps.",
  },
  sdk_user_messages: {
    label: "User messages",
    unlocks:
      "Workflow names and missing tools read from what users asked, not from the agent's searches.",
  },
  sdk_end_users: { label: "End user ids", unlocks: "Patterns per user, and cleaner sessions." },
  both_linked: {
    label: "Linked runs",
    unlocks: "Cost per run, model calls, and what users asked next to what the agent searched.",
  },
};

export interface SetupPill {
  key: SetupKey;
  source: SetupSource;
  status: SetupStatus;
  tone: SetupTone;
  label: string;
  /** "Not sent", "Partly sent · 42%", "Received". */
  statusText: string;
  /** On the chip beside its name: "42%" when partly sent, else null. */
  chipNote: string | null;
  unlocks: string;
  guides: readonly SetupGuide[];
}

export interface SetupGroup {
  source: SetupSource;
  /** "OpenTelemetry" or "SDK" when the project sends both; null otherwise. */
  title: string | null;
  /** The data points to act on: not sent, or sent only sometimes. */
  pills: readonly SetupPill[];
}

export interface SetupCardModel {
  /** Data points not fully on. */
  missing: number;
  /** One line when the data shows something wrong (runs mixed together), else null. */
  alert: string | null;
  /** "4 settings missing". */
  title: string;
  groups: readonly SetupGroup[];
  /** What already arrives, named in the open guide's footer. */
  received: readonly SetupPill[];
}

export function sourceOf(key: SetupKey): SetupSource {
  return key.startsWith("sdk_") ? "sdk" : "otel";
}

export function setupStatusText(fact: Pick<SetupFact, "status" | "share">): string {
  if (fact.status === "on") return "Received";
  if (fact.status === "off") return "Not sent";
  return `Partly sent · ${formatSharePercent(fact.share)}`;
}

export function setupPill(fact: SetupFact): SetupPill {
  const copy = COPY[fact.key];
  return {
    key: fact.key,
    source: sourceOf(fact.key),
    status: fact.status,
    tone: TONE[fact.status],
    label: copy.label,
    statusText: setupStatusText(fact),
    chipNote: fact.status === "partial" ? formatSharePercent(fact.share) : null,
    unlocks: copy.unlocks,
    guides: setupGuides(fact.key),
  };
}

const GROUP_TITLE: Readonly<Record<SetupSource, string>> = { otel: "OpenTelemetry", sdk: "SDK" };

/** The card, or null when there is nothing to turn on (or the run stored no setup facts). */
export function setupCardModel(setup: StoredSetup | null | undefined): SetupCardModel | null {
  if (!setup) return null;
  const pills = setup.facts.map(setupPill);
  const todo = pills.filter((pill) => pill.status !== "on");
  if (todo.length === 0) return null;
  const both = setup.lanes.otel && setup.lanes.sdk;
  const sources: SetupSource[] = (["otel", "sdk"] as const).filter((source) =>
    todo.some((pill) => pill.source === source),
  );
  const groups = sources.map((source) => ({
    source,
    title: both ? GROUP_TITLE[source] : null,
    // What unlocks the most first, then not sent before partly sent.
    pills: todo.filter((pill) => pill.source === source).sort((a, b) => rank(a) - rank(b)),
  }));
  const count = todo.length;
  return {
    missing: count,
    alert: setup.warnings?.includes("mixed_runs") ? MIXED_RUNS_ALERT : null,
    title: count === 1 ? "1 setting missing" : `${count} settings missing`,
    groups,
    received: pills.filter((pill) => pill.status === "on"),
  };
}

/** Runs without turn ids that hold several users' calls: the card says so above the chips. */
export const MIXED_RUNS_ALERT =
  "Calls from different users land in the same run, so run shapes, tasks and per-run problems are hidden until turn ids arrive.";

/** The data points everything else rests on come first. */
const PRIORITY: readonly SetupKey[] = [
  "otel_tool_spans",
  "sdk_tool_calls",
  "otel_trace_context",
  "sdk_turn_ids",
  "otel_conversation_id",
];

function rank(pill: SetupPill): number {
  const first = PRIORITY.indexOf(pill.key);
  return (first === -1 ? PRIORITY.length : first) * 2 + (pill.status === "off" ? 0 : 1);
}

/**
 * True when no request text arrives from any lane: no OpenTelemetry content,
 * no user messages and no search queries from the SDK. Unknown (no facts) is
 * not missing.
 */
export function asksMissing(setup: StoredSetup | null | undefined): boolean {
  if (!setup) return false;
  const status = (key: SetupKey) => setup.facts.find((f) => f.key === key)?.status ?? null;
  const otelAsks = setup.lanes.otel && status("otel_content") !== "off";
  const sdkAsks =
    setup.lanes.sdk &&
    (status("sdk_user_messages") !== "off" || (status("sdk_search_queries") ?? "off") !== "off");
  return !otelAsks && !sdkAsks;
}

/* - Per-visit state ----------------------------------------------------------- */

/** The card's state for one page view. Never stored: a new load starts fresh. */
export interface SetupCardState {
  dismissed: boolean;
  /** The pill whose guide is open, one at a time. */
  open: SetupKey | null;
}

export type SetupCardAction =
  | { type: "dismiss" }
  | { type: "toggle"; key: SetupKey }
  | { type: "show"; key: SetupKey };

/** Every page load starts here: shown, nothing open. Reads no storage. */
export function initialSetupCardState(): SetupCardState {
  return { dismissed: false, open: null };
}

export function setupCardReducer(state: SetupCardState, action: SetupCardAction): SetupCardState {
  if (action.type === "dismiss") return { ...state, dismissed: true, open: null };
  // A section asked for this guide: bring the card back if it was dismissed, and open it.
  if (action.type === "show") return { dismissed: false, open: action.key };
  return { ...state, open: state.open === action.key ? null : action.key };
}
