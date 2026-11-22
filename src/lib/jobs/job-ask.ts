/**
 * The ask of a backend job's agent run (ratel-cloud #517, RC-834): the `invoke_agent` root span
 * of Ratel's own telemetry, which is exported to Ratel's own project. The job's project belongs
 * to another organization and its payload can hold a user id, tool definitions or rewritten
 * catalog text, so the ask is the job in words and only the payload keys its kind allows: ids
 * and settings, never a project id, a user id, free text, tool definitions, patches or
 * connection details. Pure.
 *
 * Owned (ADR-0030): upstream keeps one table of every agent job kind, typed by each kind's
 * payload. Here `lib/jobs` sits below the modules that own those payloads (`check-layers`), so
 * the table ({@link JOB_ASKS}) holds the words and the allowlists without the payload types, and
 * each module's `register.ts` checks its kind's entry against its payload with {@link jobAskFor}
 * and passes it to `inProjectLogContext`. The words and the allowlists are upstream's.
 */

/** Every payload key with its decision: `true` shows it in the ask. A new payload field fails typecheck until it has one. */
export type Allowlist<P> = { readonly [K in keyof Required<P>]: boolean };

/** A job kind's ask: the job as a short verb phrase, and which payload keys it may show. */
export interface JobAskSpec {
  readonly words: string;
  readonly allow: Readonly<Record<string, boolean>>;
}

/** The payload of a job queued with none. */
export type NoPayload = Record<never, never>;

/**
 * Each job kind that runs as one agent run (`inProjectLogContext`), with its ask: the words and
 * which payload keys it may show. Its owner checks the keys against its payload ({@link jobAskFor}).
 */
export const JOB_ASKS = {
  simulate_task_eval: { words: "Simulate a task eval", allow: { runId: true } },
  label_workflows: { words: "Label workflows", allow: {} },
  assign_topics: { words: "Assign topics", allow: {} },
  match_quality_run: {
    words: "Run a match quality analysis",
    allow: {
      runId: true,
      projectId: false,
      projectName: false,
      experimentName: false,
      windowStart: true,
      windowEnd: true,
      judge: true,
      backtest: true,
      judgeBudgetUsd: false,
    },
  },
  cluster_intents: { words: "Cluster intents", allow: {} },
  draft_fix: { words: "Draft a fix", allow: { fixId: true, requestedBy: false } },
  what_if_step: { words: "Run a what-if step", allow: { runId: true, variant: false } },
  run_eval_set: {
    words: "Run an eval set",
    allow: { runId: true, workflowId: true, evalId: true },
  },
  simulate_eval_set: {
    words: "Simulate a fix on an eval set",
    allow: { runId: true, evalIds: true, change: false },
  },
} as const satisfies Record<string, JobAskSpec>;

/** A job kind that runs as one agent run. */
export type AgentJobKind = keyof typeof JOB_ASKS;

const AGENT_JOB_KINDS = Object.keys(JOB_ASKS) as AgentJobKind[];

/** The ask before RC-834: `<job kind> for project <uuid>`, then the JSON payload or nothing. */
const OLD_JOB_ASK =
  /^([a-z][a-z0-9]*(?:_[a-z0-9]+)*) for project [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\s|$)/;

/** A shown value: an id, an ISO time or a setting word. Anything with spaces or longer is free text and is left out. */
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_LIST_VALUES = 10;

/**
 * What a job was asked to do, in words: "Draft a fix (fixId f-9)". Only the allowlisted payload
 * keys of its kind follow, in allowlist order, and only when their value is an id-like word, a
 * number, a boolean or a list of ids.
 */
export function jobAsk(spec: JobAskSpec, payload: unknown): string {
  const record = isRecord(payload) ? payload : {};
  const shown = Object.entries(spec.allow).flatMap(([key, allowed]) => {
    const value = allowed ? shownValue(record[key]) : null;
    return value === null ? [] : [`${key} ${value}`];
  });
  return shown.length > 0 ? `${spec.words} (${shown.join(", ")})` : spec.words;
}

/** A job kind's ask spec, checked against its payload type: every key needs a decision. */
export function jobAskSpec<P>(words: string, allow: Allowlist<P>): JobAskSpec {
  return { words, allow };
}

/** A {@link JOB_ASKS} entry, checked against its kind's payload type: every key needs a decision. */
export function jobAskFor<P>(spec: {
  readonly words: string;
  readonly allow: Allowlist<P>;
}): JobAskSpec {
  return spec;
}

/**
 * The job kind whose agent run asked `text`, for Intents to read the ask as
 * the job in words (RC-801): the ask {@link jobAsk} writes, with or without
 * its ids, or a stored run's old machine ask (`<kind> for project <uuid>`,
 * then its payload). Null for any other ask.
 */
export function jobKindOfAsk(text: string): AgentJobKind | null {
  const trimmed = text.trim();
  const old = OLD_JOB_ASK.exec(trimmed)?.[1];
  if (old) return isAgentJobKind(old) ? old : null;
  for (const kind of AGENT_JOB_KINDS) {
    const spec: JobAskSpec = JOB_ASKS[kind];
    if (trimmed === spec.words) return kind;
    if (!trimmed.startsWith(`${spec.words} (`) || !trimmed.endsWith(")")) continue;
    const shown = trimmed.slice(spec.words.length + 2, -1).split(", ");
    if (shown.every((part) => spec.allow[part.slice(0, part.indexOf(" "))] === true)) return kind;
  }
  return null;
}

function isAgentJobKind(kind: string): kind is AgentJobKind {
  return Object.hasOwn(JOB_ASKS, kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shownValue(value: unknown): string | null {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") return SAFE_VALUE.test(value) ? value : null;
  if (!Array.isArray(value)) return null;
  const ids = value.filter(
    (item): item is string => typeof item === "string" && SAFE_VALUE.test(item),
  );
  if (ids.length === 0) return null;
  const more = ids.length > MAX_LIST_VALUES ? ` +${ids.length - MAX_LIST_VALUES}` : "";
  return `${ids.slice(0, MAX_LIST_VALUES).join(" ")}${more}`;
}
