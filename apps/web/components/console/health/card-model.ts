import { formatCount } from "@/lib/readings/trace-signals/claims";
import type { SignalKind, SignalView, SubjectChip } from "@/lib/readings/trace-signals/view";

/**
 * Pure helpers the signal list (server) and the signal rows (client) share.
 * Kept out of both component files so neither has to import the other, and so
 * the server can call them (a function exported from a client module cannot).
 */

/** Where the quiet upgrade links go; the same page the app's paywall sends people to. */
export const UPGRADE_HREF = "/billing";

/**
 * Most example turns a card carries, whatever the plan allows. The list pages
 * them, so this only guards against a flood; it is not the page size.
 */
export const MAX_STORY_ROWS = 12;

/** Problems the list shows before "Show all N problems". */
export const TOP_PROBLEMS = 5;

/** Entrance stagger: the list starts after the band, map and shapes have landed. */
const ENTER_BASE_MS = 620;
const ENTER_STEP_MS = 70;
const ENTER_MAX_STEPS = 10;

/** `620 + i * 70` ms, capped at the tenth card so a long list does not keep arriving. */
export function cardEnterDelayMs(index: number): number {
  return ENTER_BASE_MS + Math.min(Math.max(0, index), ENTER_MAX_STEPS) * ENTER_STEP_MS;
}

/** How many story rows a card renders on a plan that allows `perSignal`. */
export function storyRowLimit(perSignal: number): number {
  return Math.min(MAX_STORY_ROWS, Math.max(0, Math.floor(perSignal)));
}

export const INFERRED_BOUNDARIES_CAVEAT =
  "Turn boundaries here are inferred from timing, so a few turns may be split or joined.";

/** The one caveat band an open card shows: the signal's own, else the inferred-turns note. */
export function signalCaveat(signal: Pick<SignalView, "caveat" | "turnSourceMix">): string | null {
  if (signal.caveat) return signal.caveat;
  return signal.turnSourceMix.inferred > 0 ? INFERRED_BOUNDARIES_CAVEAT : null;
}

/** Worst first: severity, then impact. A copy, never a sort in place. */
export function sortSignals(signals: readonly SignalView[]): readonly SignalView[] {
  return [...signals].sort((a, b) => b.severity - a.severity || b.impact - a.impact);
}

/* - One open at a time ------------------------------------------------------ */

/**
 * The list is an accordion: clicking a closed row opens it and closes whichever
 * was open; clicking the open row closes it. Returns the anchor left open.
 */
export function nextOpenAnchor(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

/**
 * Why the open card is open: the reader clicked it, or the page was sent to it
 * (a `#signal-<id>` hash, or the flow map's "Open problem"). Only a sent-to
 * card reveals a hidden list and is scrolled to; a click never moves the page.
 */
export type OpenSource = "click" | "hash" | "request";

/** The reader's (or the flow map's) last word on which card is open; null follows the hash. */
export interface OpenChoice {
  anchor: string | null;
  source: OpenSource;
  /** The card the reader last toggled; the only one whose body animates. */
  toggled: string | null;
}

export type OpenAction =
  /** A row's own toggle; `hashAnchor` is what the hash names, for the first click. */
  | { type: "click"; anchor: string; hashAnchor: string | null }
  /** The hash moved to a signal anchor: follow it again. */
  | { type: "hash" }
  /** The flow map asked for a card whose anchor the hash already names. */
  | { type: "request"; anchor: string };

export function openReducer(choice: OpenChoice | null, action: OpenAction): OpenChoice | null {
  switch (action.type) {
    case "click":
      return {
        anchor: nextOpenAnchor(choice ? choice.anchor : action.hashAnchor, action.anchor),
        source: "click",
        toggled: action.anchor,
      };
    case "hash":
      return null;
    case "request":
      return { anchor: action.anchor, source: "request", toggled: null };
  }
}

/** The one open card, why, and which card animates, from a choice and the hash. */
export function resolveOpen(
  choice: OpenChoice | null,
  hashAnchor: string | null,
): { openAnchor: string | null; source: OpenSource; toggled: string | null } {
  return choice
    ? { openAnchor: choice.anchor, source: choice.source, toggled: choice.toggled }
    : { openAnchor: hashAnchor, source: "hash", toggled: null };
}

/* - Keeping the list in view ------------------------------------------------ */

/**
 * Where the list's top lands when it is scrolled into view: below the app's
 * sticky header, matching the rows' `scroll-mt-24`.
 */
export const LIST_TOP_OFFSET_PX = 96;

/**
 * How far to scroll (for `window.scrollBy`) after the list switches length, so
 * the reader never lands on empty page. `beforeTop` and `afterTop` are the
 * list's top edge in the viewport before and after the switch.
 *
 * Expanding keeps the list exactly where it was. Collapsing keeps it where it
 * was too when its top was on screen; when the reader had scrolled past it,
 * the top is brought back to just under the header, so the short list is in
 * view the moment it renders.
 */
export function listScrollDelta({
  beforeTop,
  afterTop,
  collapsing,
  minTop = LIST_TOP_OFFSET_PX,
}: {
  beforeTop: number;
  afterTop: number;
  collapsing: boolean;
  minTop?: number;
}): number {
  const desired = collapsing ? Math.max(beforeTop, minTop) : beforeTop;
  return Math.round(afterTop - desired);
}

/* - Severity ---------------------------------------------------------------- */

/**
 * How loud a row is. Coral is worth fixing now, amber is worth a look, and a
 * signal still too early to call stays muted until it has earned a colour.
 */
export type SignalTone = "coral" | "amber" | "muted";

/** Severity at or above which a signal reads coral. */
export const CORAL_SEVERITY = 0.6;

export function signalTone(severity: number, tooEarly: boolean): SignalTone {
  if (tooEarly) return "muted";
  return severity >= CORAL_SEVERITY ? "coral" : "amber";
}

/** What each dot means, in words: the dot's accessible name and the list's legend. */
export const TONE_LABELS: Record<SignalTone, string> = {
  coral: "Fix now",
  amber: "Watch",
  muted: "Too early to call",
};

/* - Groups ------------------------------------------------------------------ */

export type SignalGroupKey = "picking" | "reliability" | "speed" | "cleanup";

/** The four plain areas a problem belongs to, in the order they are declared. */
export const SIGNAL_GROUP_LABELS: Record<SignalGroupKey, string> = {
  picking: "Picking the wrong tool",
  reliability: "Reliability",
  speed: "Speed",
  cleanup: "Catalog clean-up",
};

export const SIGNAL_KIND_GROUP: { readonly [K in SignalKind]: SignalGroupKey } = {
  first_try_miss: "picking",
  buried_tool: "picking",
  magnet: "picking",
  sibling_confusion: "picking",
  no_follow_through: "picking",
  abandoned_search: "picking",
  unstable_intent: "picking",
  error_loop: "reliability",
  repeat_invoke: "reliability",
  latency_outlier: "speed",
  dead_tool: "cleanup",
  padding_share: "cleanup",
  sequence_chain: "cleanup",
  fragmented_intents: "cleanup",
  cooccurring_intents: "cleanup",
  tool_switch: "picking",
  unknown_tool: "picking",
  empty_result: "reliability",
  long_turn: "speed",
  blocked_action: "reliability",
  identical_retry: "reliability",
  wait_heavy: "speed",
  token_heavy: "speed",
  system_turn_failing: "reliability",
  agent_failing: "reliability",
  unused_tool: "cleanup",
  workflow_failing: "reliability",
  workflow_slow: "speed",
  workflow_fixed_chain: "cleanup",
  self_correcting: "reliability",
};

export interface SignalGroup {
  key: SignalGroupKey;
  label: string;
  /** Worst first. */
  signals: readonly SignalView[];
}

/**
 * The list in areas: each group worst first inside, and the groups ordered by
 * their worst problem, so the top of the page is always the most urgent area.
 * Empty groups are left out.
 */
export function groupSignals(signals: readonly SignalView[]): readonly SignalGroup[] {
  const sorted = sortSignals(signals);
  // First appearance in the worst-first list decides a group's place.
  const order = [...new Set(sorted.map((signal) => SIGNAL_KIND_GROUP[signal.kind]))];
  return order.map((key) => ({
    key,
    label: SIGNAL_GROUP_LABELS[key],
    signals: sorted.filter((signal) => SIGNAL_KIND_GROUP[signal.kind] === key),
  }));
}

/* - Words ------------------------------------------------------------------- */

/**
 * A fix split into its instruction and the reason after it, so the row can
 * print the first sentence and the details the rest. A sentence ends at a
 * period followed by a space and a capital; decimals and ids stay whole.
 */
export function splitFix(fix: string): { lead: string; rest: string | null } {
  const match = /\.\s+(?=[A-Z])/.exec(fix);
  if (!match) return { lead: fix.trim(), rest: null };
  const cut = match.index + 1;
  const rest = fix.slice(cut).trim();
  return { lead: fix.slice(0, cut).trim(), rest: rest.length > 0 ? rest : null };
}

/**
 * A subject names its tools up to this many. Past it, a sentence of names
 * ("a and b and c and d ...") is a wall of text, so the row says how many
 * ("18 tools") and the opened details list them.
 */
export const SUBJECT_NAME_LIMIT = 3;

/** What a row names as its subject: the tools it is about, how many there are, a short label, or nothing. */
export type SubjectText =
  | { kind: "names"; names: readonly string[]; joiner: "and" | "then" }
  | { kind: "count"; count: number; text: string }
  | { kind: "label"; text: string }
  | null;

type SubjectSource = Pick<SignalView, "kind" | "subject" | "figure">;

function chipNames(chips: readonly SubjectChip[]): string[] {
  return chips.map((chip) => chip.label).filter((label) => label.length > 0);
}

/**
 * How many tools a subject is about. Usually its chips; a dead-tool signal
 * names at most a capped number of them, and its figure is the full count.
 */
export function subjectTotal(signal: SubjectSource): number {
  const named = chipNames(signal.subject.chips).length;
  if (signal.kind === "dead_tool" && signal.figure.unit === "count")
    return Math.max(named, signal.figure.value);
  return named;
}

/** "18 tools", or "4 skills" when every one is a skill. */
export function countNoun(count: number, chips: readonly Pick<SubjectChip, "entryKind">[]): string {
  const skills = chips.length > 0 && chips.every((chip) => chip.entryKind === "skill");
  const noun = skills ? (count === 1 ? "skill" : "skills") : count === 1 ? "tool" : "tools";
  return `${formatCount(count)} ${noun}`;
}

/** Whether a subject is too long to name, so it is counted on the row and listed in the details. */
export function subjectIsCounted(signal: SubjectSource): boolean {
  return subjectTotal(signal) > SUBJECT_NAME_LIMIT;
}

/**
 * Whether the opened details list the subject's tools: always for a counted
 * subject, and for several tools the claim sentence does not name ("The same
 * ask resolves to 3 different tools."), since the row may cut them short.
 */
export function subjectNeedsList(
  signal: SubjectSource & Pick<SignalView, "claimSegments">,
): boolean {
  if (subjectIsCounted(signal)) return true;
  const named = chipNames(signal.subject.chips).length;
  return named > 1 && !signal.claimSegments.some((segment) => segment.kind === "subject");
}

export function subjectText(signal: SubjectSource): SubjectText {
  const names = chipNames(signal.subject.chips);
  if (subjectIsCounted(signal)) {
    const count = subjectTotal(signal);
    return { kind: "count", count, text: countNoun(count, signal.subject.chips) };
  }
  if (names.length > 0) {
    return { kind: "names", names, joiner: signal.kind === "sequence_chain" ? "then" : "and" };
  }
  // A cluster of asks has no tool to name; a project-level signal is about
  // everything, which the title already says.
  return signal.subject.kind === "query_cluster" && signal.subject.label
    ? { kind: "label", text: signal.subject.label }
    : null;
}

/**
 * What goes before name `index` of `count`: "a, b and c", never "a and b and
 * c"; a chain ("a then b") keeps its own word.
 */
export function nameSeparator(index: number, count: number, joiner: "and" | "then"): string {
  if (index === 0) return "";
  if (joiner === "then") return " then ";
  return index === count - 1 ? " and " : ", ";
}

/** A subject in plain words, for an accessible name: never a long chain of names. */
export function subjectPlainText(subject: SubjectText): string {
  if (subject === null) return "";
  if (subject.kind === "names") {
    return subject.names
      .map((name, at) => `${nameSeparator(at, subject.names.length, subject.joiner)}${name}`)
      .join("");
  }
  return subject.text;
}

/* - Story window ------------------------------------------------------------ */

/** Steps a timeline shows before it folds the rest behind "N more steps". */
export const STORY_STEP_LIMIT = 7;

/** Which slice of a turn's steps a folded timeline shows: `[start, end)`. */
export interface StoryWindow {
  start: number;
  end: number;
  hiddenBefore: number;
  hiddenAfter: number;
}

/**
 * A long turn folded to the part that matters: up to `limit` steps, starting
 * two before the first flagged one, so the offending step is always on screen
 * with a little of what led to it.
 */
export function storyWindow(
  steps: readonly { flag?: unknown }[],
  limit = STORY_STEP_LIMIT,
): StoryWindow {
  const total = steps.length;
  const size = Math.max(1, Math.floor(limit));
  if (total <= size) return { start: 0, end: total, hiddenBefore: 0, hiddenAfter: 0 };
  const flagged = steps.findIndex((step) => step.flag !== undefined);
  const start = Math.max(0, Math.min((flagged < 0 ? 0 : flagged) - 2, total - size));
  const end = start + size;
  return { start, end, hiddenBefore: start, hiddenAfter: total - end };
}

/* - Example pager ----------------------------------------------------------- */

export interface ExamplePage {
  /** Zero-based, clamped into range. */
  index: number;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** "2 of 5". */
  label: string;
}

/** One example at a time: where the pager is, clamped so it can never point past the end. */
export function examplePage(index: number, total: number): ExamplePage {
  const count = Math.max(0, Math.floor(total));
  const at = count === 0 ? 0 : Math.min(Math.max(0, Math.floor(index)), count - 1);
  return {
    index: at,
    total: count,
    hasPrev: at > 0,
    hasNext: at < count - 1,
    label: count === 0 ? "0 of 0" : `${at + 1} of ${count}`,
  };
}

/* - Example list ------------------------------------------------------------ */

/**
 * How many example turns the list shows per page; the reader picks. There is
 * no "all": a long list stays paged, and the largest page is 20.
 */
export type ExamplePageSize = 1 | 5 | 20;

export const EXAMPLE_PAGE_SIZES: readonly ExamplePageSize[] = [1, 5, 20];

/** The largest page, which also takes over an "all" stored before pages were capped. */
export const MAX_EXAMPLE_PAGE_SIZE: ExamplePageSize = 20;

/** Five at once: enough to see a pattern, short enough to scan. */
export const DEFAULT_EXAMPLE_PAGE_SIZE: ExamplePageSize = 5;

/** Where a viewer's choice is remembered, in their own browser only. */
export const EXAMPLE_PAGE_SIZE_STORAGE_KEY = "ratel.health.examplePageSize";

/** A stored choice read back; anything unknown falls back to the default. */
export function parseExamplePageSize(raw: string | null | undefined): ExamplePageSize {
  // An older "all" meant "as many as you can": the largest page now.
  if (raw === "all") return MAX_EXAMPLE_PAGE_SIZE;
  const size = Number(raw);
  return size === 1 || size === 5 || size === 20 ? size : DEFAULT_EXAMPLE_PAGE_SIZE;
}

/**
 * The sizes worth offering for `count` examples: none for a single example,
 * and no 20 when 5 already fits them all.
 */
export function examplePageSizeOptions(count: number): readonly ExamplePageSize[] {
  if (count <= 1) return [];
  // Five or fewer: "20" would show the same list as "5", the default.
  if (count <= 5) return [1, 5];
  return EXAMPLE_PAGE_SIZES;
}

/**
 * The size in force. On a card with five or fewer examples, a stored 20 reads
 * as 5 (the same view, under the default's name); otherwise the stored choice
 * stands.
 */
export function effectivePageSize(size: ExamplePageSize, count: number): ExamplePageSize {
  if (count <= 5) return size === 1 && count > 1 ? 1 : 5;
  return size;
}

export interface ExampleSlice {
  /** `[start, end)` into the examples. */
  start: number;
  end: number;
  /** Zero-based page, clamped into range. */
  page: number;
  pageCount: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** "2 of 6" for one at a time, "1 to 5 of 6" for a page of several. */
  label: string;
}

/** A page of the example list, clamped so it can never point past the end. */
export function exampleSlice(page: number, size: ExamplePageSize, count: number): ExampleSlice {
  const total = Math.max(0, Math.floor(count));
  const per = size;
  const pageCount = Math.max(1, Math.ceil(total / per));
  const at = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  const start = Math.min(at * per, total);
  const end = Math.min(start + per, total);
  const label =
    total === 0
      ? "0 of 0"
      : end - start === 1
        ? `${start + 1} of ${total}`
        : `${start + 1} to ${end} of ${total}`;
  return { start, end, page: at, pageCount, hasPrev: at > 0, hasNext: at < pageCount - 1, label };
}

/* - Step glyphs and the one-line gist -------------------------------------- */

/** The small glyph beside a step or beat; `kinds.tsx` maps each to an icon. */
export type StepGlyphKind = "search" | "listed" | "tool" | "skill" | "error" | "slow";

/** Calls at or above this are slow enough to mention in a story. */
export const SLOW_STEP_MS = 1_000;

/** Whether an invoked id is one of the signal's skills rather than a tool. */
export function invokeGlyph(
  toolId: string,
  skillIds: ReadonlySet<string> | undefined,
): "tool" | "skill" {
  return skillIds?.has(toolId) ? "skill" : "tool";
}

/* - Replay ------------------------------------------------------------------ */

/** Pause before the first beat, so the row has started to open. */
export const REPLAY_FIRST_BEAT_MS = 90;

/** Time between beats of an example's replay; each beat settles in over 260 ms. */
export const REPLAY_BEAT_MS = 140;

/** When beat `index` starts, from the moment the example opens. */
export function replayBeatAt(index: number): number {
  return REPLAY_FIRST_BEAT_MS + Math.max(0, Math.floor(index)) * REPLAY_BEAT_MS;
}
