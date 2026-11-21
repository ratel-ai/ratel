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
 * each module's `register.ts` declares its kind's spec with {@link jobAskSpec} and passes it to
 * `inProjectLogContext`. The words and the allowlists are upstream's.
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
