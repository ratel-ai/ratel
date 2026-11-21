/**
 * The capture nudge's small pieces of state and copy, pure where they can be.
 *
 * The 30-day "Not now" is a per-viewer convenience, so it lives in localStorage.
 * Every read and write is wrapped: private windows, blocked site data and
 * server renders all throw or have no storage, and in each case the nudge just
 * shows again, which is the safe way to be wrong.
 */

export const NUDGE_SNOOZE_DAYS = 30;
const DAY_MS = 86_400_000;
const STORAGE_PREFIX = "ratel:agent-health:capture-nudge-snoozed-until:";
/** Fired on this tab after a snooze, since `storage` events only reach other tabs. */
const SNOOZE_EVENT = "ratel:capture-nudge-snoozed";

export function nudgeStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

/** Epoch ms the nudge is snoozed until, or 0. Never throws. */
export function readNudgeSnooze(
  projectId: string,
  storage: Storage | null = safeStorage(),
): number {
  try {
    const raw = storage?.getItem(nudgeStorageKey(projectId));
    const until = raw ? Number(raw) : 0;
    return Number.isFinite(until) && until > 0 ? until : 0;
  } catch {
    // Storage refused: treat as never snoozed, so the nudge shows.
    return 0;
  }
}

export function isNudgeSnoozed(until: number, now: number): boolean {
  return until > now;
}

/** Snoozes for 30 days from `now`. Returns whether it was stored. Never throws. */
export function snoozeNudge(
  projectId: string,
  now: number,
  storage: Storage | null = safeStorage(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(nudgeStorageKey(projectId), String(now + NUDGE_SNOOZE_DAYS * DAY_MS));
    if (typeof window !== "undefined") window.dispatchEvent(new Event(SNOOZE_EVENT));
    return true;
  } catch {
    // Quota or a blocked store: the dismissal still hides the nudge for this view.
    return false;
  }
}

export function subscribeToNudgeSnooze(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(SNOOZE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(SNOOZE_EVENT, onChange);
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Accessing localStorage itself throws when site data is blocked.
    return null;
  }
}

/** One line of the static snippet diff. */
export interface DiffLine {
  text: string;
  added: boolean;
}

/**
 * The change content capture needs, shown as a diff against the quickstart's
 * TypeScript setup. The Ratel span processor has no capture option of its own:
 * the OpenTelemetry GenAI instrumentation reads one environment variable, set
 * before the SDK starts.  * Mirrors the quickstart's `captureContent` lines so the nudge and the onboarding snippet
 * never disagree.
 */
export const CAPTURE_DIFF_LINES: readonly DiffLine[] = [
  { text: 'import { RatelSpanProcessor } from "@ratel-ai/cloud-sdk/otel";', added: false },
  { text: "", added: false },
  { text: "process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =", added: true },
  { text: '  "SPAN_AND_EVENT";', added: true },
  { text: "const sdk = new NodeSDK({", added: false },
];

/**
 * The change for a project that only sends OpenTelemetry: one line per
 * option it has not turned on, in the order the nudge lists them. Content
 * capture is the GenAI instrumentation's environment variable; tool
 * definitions and the conversation id are span attributes from the GenAI
 * conventions (`session.id` works too).
 */
const OTEL_DIFF: Readonly<Record<string, readonly DiffLine[]>> = {
  otel_content: [
    { text: "# Tool results and the asks behind each run", added: false },
    { text: "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_AND_EVENT", added: true },
  ],
  otel_tool_definitions: [
    { text: "# The tools offered to the model, on each model call span", added: false },
    { text: 'span.setAttribute("gen_ai.tool.definitions", JSON.stringify(tools));', added: true },
  ],
  otel_conversation_id: [
    { text: "# One id for every run of the same conversation", added: false },
    { text: 'span.setAttribute("gen_ai.conversation.id", conversationId);', added: true },
  ],
};

export function otelCaptureDiffLines(unlockKeys: readonly string[]): DiffLine[] {
  return unlockKeys.flatMap((key, index) => [
    ...(index > 0 ? [{ text: "", added: false }] : []),
    ...(OTEL_DIFF[key] ?? []),
  ]);
}

/** The nudge's heading: content capture for the SDK, the options still off for OpenTelemetry. */
export function nudgeTitle(otel: boolean, count: number): string {
  if (otel)
    return `Turn on ${count} more OpenTelemetry ${count === 1 ? "option" : "options"} to see more`;
  return `Turn on content capture to unlock ${count} more ${count === 1 ? "signal" : "signals"}`;
}
