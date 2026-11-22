import { fmtCost, fmtCount } from "@/lib/platform/format";
import { agentHealthHref, type WindowDays } from "../view";
import type { PublicStepKind } from "./kind";
import type {
  CallReading,
  CodeReading,
  HandoffReading,
  ModelCallReading,
  StepReadings,
  TaskReading,
  UserMessageReading,
} from "./metrics";
import { kindsOf, type StepsView } from "./view";

/**
 * The per-kind tables of Agent health (RC-1078) as display rows: plain words
 * and formatted figures, filtered by the shared `?steps=` preset. Pure, so the
 * page and its tests agree on every figure.
 */

export interface KindRow {
  kind: PublicStepKind;
  label: string;
  count: string;
  perRun: string;
  failed: string;
  slow: string;
  retries: string;
  detail: string;
}

export interface MeasureRow {
  label: string;
  value: string;
}

export interface RouteRow {
  key: string;
  from: string;
  to: string;
  count: string;
  failed: string;
}

export interface TaskRow {
  id: string;
  name: string;
  runs: string;
  finished: string;
  costPerRun: string;
  duration: string;
  corrections: string;
  weakest: { kind: PublicStepKind; name: string; failed: string } | null;
}

export interface StepKindTables {
  kinds: KindRow[];
  /** Null when the preset leaves model calls out or none ran. */
  model: MeasureRow[] | null;
  routes: RouteRow[] | null;
  messages: MeasureRow[] | null;
  tasks: TaskRow[];
}

/** One `?steps=` preset as a link on the Agent health page. */
export interface StepPreset {
  view: StepsView;
  label: string;
  href: string;
}

const PRESET_LABELS: Readonly<Record<StepsView, string>> = {
  all: "All",
  tools: "Tools",
  models: "Models",
  intents: "Intents",
  flow: "Flow",
};

/** The order kinds read in, as a run unfolds. */
const KIND_ORDER: readonly PublicStepKind[] = [
  "user_message",
  "model_call",
  "tool_call",
  "skill",
  "code",
  "handoff",
];

const KIND_LABELS: Readonly<Record<PublicStepKind, string>> = {
  user_message: "User messages",
  model_call: "Model calls",
  tool_call: "Tool calls",
  skill: "Skills",
  code: "Code steps",
  handoff: "Handoffs",
};

/** Presets that read the tasks, whose steps mix every kind. */
const TASK_VIEWS: ReadonlySet<StepsView> = new Set(["all", "flow"]);
const NONE = "–";

/** The tables for a reading and a preset; `taskNames` names tasks by workflow id. */
export function stepKindTables(
  readings: StepReadings,
  view: StepsView,
  taskNames: ReadonlyMap<string, string>,
): StepKindTables {
  const shown = new Set(kindsOf(view));
  const { kinds } = readings;
  const has = <K extends PublicStepKind>(kind: K) => (shown.has(kind) ? kinds[kind] : null);
  return {
    kinds: KIND_ORDER.flatMap((kind) => {
      const row = shown.has(kind) ? kindRow(kind, readings) : null;
      return row ? [row] : [];
    }),
    model: modelRows(has("model_call")),
    routes: routeRows(has("handoff")),
    messages: messageRows(has("user_message")),
    tasks: TASK_VIEWS.has(view) ? readings.tasks.map((task) => taskRow(task, taskNames)) : [],
  };
}

/** The presets as links that keep the page's window; `all` is the bare URL. */
export function stepPresets(projectId: string, windowDays: WindowDays): StepPreset[] {
  const base = agentHealthHref(projectId, windowDays);
  return (Object.keys(PRESET_LABELS) as StepsView[]).map((view) => ({
    view,
    label: PRESET_LABELS[view],
    href: view === "all" ? base : `${base}${base.includes("?") ? "&" : "?"}steps=${view}`,
  }));
}

function kindRow(kind: PublicStepKind, readings: StepReadings): KindRow | null {
  const reading = readings.kinds[kind];
  if (!reading) return null;
  const base = { kind, label: KIND_LABELS[kind] };
  const perRun = (count: number) => (readings.runs > 0 ? decimal(count / readings.runs) : NONE);
  switch (kind) {
    case "model_call": {
      const model = reading as ModelCallReading;
      const tokens = `${fmtCount(model.inputTokens)} tokens in, ${fmtCount(model.outputTokens)} out`;
      return {
        ...base,
        count: fmtCount(model.calls),
        perRun: perRun(model.calls),
        failed: percent(model.errorRate),
        slow: duration(model.p95Ms),
        retries: fmtCount(model.retries),
        detail: model.costUsd === null ? tokens : `${tokens} · ${fmtCost(model.costUsd)}`,
      };
    }
    case "tool_call":
    case "skill": {
      const calls = reading as CallReading;
      return {
        ...base,
        count: fmtCount(calls.calls),
        perRun: perRun(calls.calls),
        failed: percent(calls.errorRate),
        slow: duration(calls.p95Ms),
        retries: fmtCount(calls.retries),
        detail: `${fmtCount(calls.switches)} switched, ${fmtCount(calls.giveUps)} gave up`,
      };
    }
    case "code": {
      const code = reading as CodeReading;
      return {
        ...base,
        count: fmtCount(code.calls),
        perRun: perRun(code.calls),
        failed: percent(code.errorRate),
        slow: duration(code.p95Ms),
        retries: NONE,
        detail: code.runTimeShare === null ? NONE : `${percent(code.runTimeShare)} of run time`,
      };
    }
    case "handoff": {
      const handoff = reading as HandoffReading;
      return {
        ...base,
        count: fmtCount(handoff.count),
        perRun: perRun(handoff.count),
        failed: percent(handoff.errorRate),
        slow: NONE,
        retries: NONE,
        detail: `${fmtCount(handoff.routes.length)} ${handoff.routes.length === 1 ? "route" : "routes"}`,
      };
    }
    case "user_message": {
      const messages = reading as UserMessageReading;
      const asked = messages.askedAgain
        ? ` · ${percent(messages.askedAgain.share)} asked again`
        : "";
      return {
        ...base,
        count: fmtCount(messages.messages),
        perRun: perRun(messages.messages),
        failed: NONE,
        slow: NONE,
        retries: NONE,
        detail: `${decimal(messages.perSegment)} per task run${asked}`,
      };
    }
  }
}

function modelRows(model: ModelCallReading | null): MeasureRow[] | null {
  if (!model) return null;
  const known = model.finish.known;
  return [
    { label: "Input tokens", value: fmtCount(model.inputTokens) },
    { label: "Output tokens", value: fmtCount(model.outputTokens) },
    { label: "Reasoning tokens", value: fmtCount(model.reasoningTokens) },
    { label: "Cost", value: model.costUsd === null ? "Not priced" : fmtCost(model.costUsd) },
    { label: "Typical time", value: duration(model.p50Ms) },
    { label: "Time, 95% under", value: duration(model.p95Ms) },
    {
      label: "Stopped at the token limit",
      value: known > 0 ? `${fmtCount(model.finish.length)} of ${fmtCount(known)}` : "Not sent",
    },
    {
      label: "Blocked by the content filter",
      value:
        known > 0 ? `${fmtCount(model.finish.contentFilter)} of ${fmtCount(known)}` : "Not sent",
    },
  ];
}

function routeRows(handoff: HandoffReading | null): RouteRow[] | null {
  if (!handoff) return null;
  return handoff.routes.map((route) => ({
    key: JSON.stringify([route.from, route.to]),
    from: route.from ?? "Start of the run",
    to: route.to,
    count: fmtCount(route.count),
    failed: `${fmtCount(route.errors)} (${percent(route.errors / route.count)})`,
  }));
}

function messageRows(messages: UserMessageReading | null): MeasureRow[] | null {
  if (!messages) return null;
  const { sentiment, askedAgain } = messages;
  return [
    { label: "Messages per task run", value: decimal(messages.perSegment) },
    {
      label: "Sentiment",
      value: sentiment
        ? `${fmtCount(sentiment.positive)} positive, ${fmtCount(sentiment.neutral)} neutral, ${fmtCount(sentiment.negative)} negative`
        : "Not read yet",
    },
    {
      label: "Asked again",
      value: askedAgain
        ? `${fmtCount(askedAgain.runs)} of ${fmtCount(askedAgain.read)} (${percent(askedAgain.share)})`
        : "Not read yet",
    },
  ];
}

function taskRow(task: TaskReading, names: ReadonlyMap<string, string>): TaskRow {
  const weakest = task.weakestStep;
  return {
    id: task.workflowId,
    name: names.get(task.workflowId) ?? "Unnamed task",
    runs: fmtCount(task.runs),
    finished: percent(task.finishRate),
    costPerRun: task.costPerRun === null ? NONE : fmtCost(task.costPerRun),
    duration: duration(task.p50DurationMs),
    corrections: decimal(task.selfCorrectionsPer100),
    weakest: weakest
      ? { kind: weakest.kind, name: weakest.name, failed: percent(weakest.errorRate) }
      : null,
  };
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** One decimal at most: 3 reads "3", 1.25 reads "1.3". */
function decimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function duration(ms: number | null): string {
  if (ms === null) return NONE;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${decimal(ms / 1000)} s`;
  return `${decimal(ms / 60_000)} min`;
}
