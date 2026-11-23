import type { HealthScoreView } from "@/lib/readings/trace-signals/health-score";
import type { EarlyProgress } from "@/lib/readings/trace-signals/signals/early-reading";
import type { SignalKind } from "@/lib/readings/trace-signals/view";

/**
 * The health card's data (get_agent_health's result, the part it reads) and
 * the pure decisions over it: which state the card is in, how issues rank,
 * and when a reading is old enough to offer a fresh one. Pure, so each is
 * pinned by model.test.ts.
 */

export interface Issue {
  id: string;
  kind: SignalKind;
  title: string;
  claim: string;
  cost: string;
  whatToDo: string;
  figure: string;
  caveat: string | null;
  subject: { kind: string; label: string; tools: { id: string; label: string }[] };
  severity: number;
  n: number;
  hideable: boolean;
  /** Whole points fixing it alone wins back now; null without a score (none read yet). From the view model (withHealthScore). */
  points: number | null;
  href: string;
}

/**
 * One row of the console's Issues list (`components/health/v2/issue-rows.ts`),
 * as get_agent_health's view model sends it: a kind of issue and the issues it
 * stands for. The card lists these, so it shows what the page shows.
 */
export interface HealthRow {
  /** Stable per kind of issue. */
  key: string;
  kind: SignalKind;
  title: string;
  /** Fix it now, watch it, or still too early to call. */
  tone: "fix_now" | "watch" | "early";
  /** The tools it names: the first members', how many members more, or a count when they are many. */
  tools: { shown: readonly (readonly string[])[]; more: number; count: string | null };
  /** What it is about when that is no tool: "Whole project". */
  scope: string | null;
  /** What it is about, in a few words: "18 tools", "refund_payment, get_order +3", "Whole project". */
  about: string | null;
  /** The one number that matters and what it counts. */
  figure: { display: string; caption: string };
  /** Worst first; the issues the row stands for. */
  memberIds: readonly string[];
  /** Whole points fixing all of it wins back now; null without a score, or when it is too early to call. */
  points: number | null;
}

export interface HiddenIssue {
  id: string;
  kind: SignalKind;
  toolId: string | null;
  label: string;
}

/** The Health score as get_agent_health sends it: the page's view without its per-issue parts. */
export type ScoreData = Omit<HealthScoreView, "parts">;

export interface HealthState {
  kind: string;
  title: string;
  body: string;
  updating?: boolean;
  working?: boolean;
  phase?: string;
}

export interface HealthData {
  windowDays: number;
  readiness: "no_telemetry" | "collecting" | "ready";
  state: HealthState;
  turns: number;
  floor: number;
  computedAt: string | null;
  issues: Issue[];
  /** Seen but not yet sure; the members of the rows too early to call. */
  tooEarly?: Issue[];
  /** The console's rows, in its order (withHealthScore). */
  rows?: HealthRow[];
  /** The console's line over the rows: "9 issues across 17 tools, most points first."; null when the result came without its view model. */
  line?: string | null;
  /** The reading is early: the score is provisional, shown as "Calculating" with no change or trend (withHealthScore). */
  early?: boolean;
  /** How far the early reading has got; null when it is not early, or the count failed. */
  progress?: EarlyProgress | null;
  openIssueCount: number;
  lockedIssueCount: number;
  hiddenIssues: HiddenIssue[];
  href: string;
  score?: ScoreData | null;
}

/** What get_analysis_freshness answers with section "health". */
export interface FreshnessData {
  updatedAt: string | null;
  working: boolean;
  line: string | null;
  section: { name: string; lastDoneAt: string | null; pending: number } | null;
}

/** Worst first by what fixing it is worth: the points it wins back, then severity. */
export function rankIssues(issues: readonly Issue[]): Issue[] {
  return [...issues].sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || b.severity - a.severity);
}

/** An issue as a row of its own: what the card lists when a result came without the console's rows. */
function rowOfOne(issue: Issue): HealthRow {
  const tools = issue.subject.tools.map((tool) => tool.label).filter((label) => label.length > 0);
  return {
    key: issue.id,
    kind: issue.kind,
    title: issue.title,
    tone: "watch",
    tools: { shown: tools.length > 0 ? [tools] : [], more: 0, count: null },
    scope: tools.length > 0 ? null : issue.subject.label || null,
    about: tools.length > 0 ? tools.join(" → ") : issue.subject.label || null,
    figure: { display: issue.figure, caption: "" },
    memberIds: [issue.id],
    points: issue.points,
  };
}

/**
 * get_agent_health's data with the Health score, each issue's points and the
 * console's rows put back in. They travel only in the result's view model
 * (`_meta["sh.ratel/view"]`, `kind: "health_score"`), so the agent's result
 * stays main's. Without one (a host that passes no view model) there is no
 * score, every issue's points are null and each issue is a row of its own.
 */
export function withHealthScore(
  data: HealthData,
  view: Record<string, unknown> | undefined,
): HealthData {
  const scored =
    view?.kind === "health_score"
      ? (view as {
          score?: ScoreData | null;
          points?: Record<string, number>;
          rows?: HealthRow[];
          line?: string;
          early?: boolean;
          progress?: EarlyProgress | null;
        })
      : null;
  const points = scored?.points ?? {};
  const pointsOf = (issue: Issue) => ({
    ...issue,
    points: typeof points[issue.id] === "number" ? points[issue.id]! : null,
  });
  const issues = data.issues.map(pointsOf);
  return {
    ...data,
    score: scored?.score ?? null,
    issues,
    tooEarly: (data.tooEarly ?? []).map(pointsOf),
    rows: Array.isArray(scored?.rows) ? scored.rows : rankIssues(issues).map(rowOfOne),
    line: typeof scored?.line === "string" ? scored.line : null,
    early: scored?.early === true,
    progress: scored?.progress ?? null,
  };
}

/** The rows the card lists: the console's, without the issues the user has just hidden (a row with none left goes). */
export function rowsShown(
  data: Pick<HealthData, "rows">,
  edits: Pick<HiddenEdits, "hiddenNow">,
): HealthRow[] {
  return (data.rows ?? [])
    .map((row) => ({ ...row, memberIds: row.memberIds.filter((id) => !edits.hiddenNow.has(id)) }))
    .filter((row) => row.memberIds.length > 0);
}

/** The row an issue id belongs to: any of its members. */
export function rowOfIssue(rows: readonly HealthRow[], issueId: string | null): HealthRow | null {
  return issueId ? (rows.find((row) => row.memberIds.includes(issueId)) ?? null) : null;
}

/** A row's issues the result carries, worst first. One cut by the tool's `limit` is not there. */
export function rowMembers(row: HealthRow, data: Pick<HealthData, "issues" | "tooEarly">): Issue[] {
  const byId = new Map(
    [...data.issues, ...(data.tooEarly ?? [])].map((issue) => [issue.id, issue]),
  );
  return row.memberIds.flatMap((id) => byId.get(id) ?? []);
}

/** The three fixes worth the most points, as the console's score lists them (`scoreFixes` in SummaryView.tsx). */
export function nextFixes(rows: readonly HealthRow[]): HealthRow[] {
  return rows.filter((row) => (row.points ?? 0) >= 1).slice(0, 3);
}

export type CardAction = "setup" | "read" | "open" | null;

/** The card shows its reading, or one message with at most one way forward. */
export type CardState =
  | { kind: "reading" }
  | { kind: "message"; title: string; body: string; action: CardAction; working: boolean };

/**
 * Which of the page's states the card is in. The words are the page's own
 * (`state.title`, `state.body`, from healthStateCopy on the server); the card
 * only picks the button: set up with no runs, read now when a reading could
 * help, the console for the rest.
 */
export function cardState(data: Pick<HealthData, "readiness" | "state">): CardState {
  const { state } = data;
  const message = (action: CardAction, working = false, fallback = "") => ({
    kind: "message" as const,
    title: state.title || fallback,
    body: state.body,
    action,
    working,
  });
  if (data.readiness === "no_telemetry" || state.kind === "nothing_yet")
    return message("setup", false, "No runs yet");
  if (state.kind === "building")
    return state.working
      ? message(null, true, "Reading your runs")
      : message("read", false, "Reading your runs");
  if (state.kind === "too_few" || data.readiness === "collecting")
    return message("read", true, "Too early to call");
  if (state.kind !== "ready") return message("open", false, "Agent health");
  return { kind: "reading" };
}

/** A reading older than this offers a fresh one. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface ReadingAge {
  /** "read 6 h ago"; null before any reading. */
  text: string | null;
  stale: boolean;
}

export function readingAge(computedAt: string | null, now: number): ReadingAge {
  if (!computedAt) return { text: null, stale: false };
  const ms = Math.max(0, now - Date.parse(computedAt));
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.round(minutes / 60);
  const text =
    minutes < 60
      ? `read ${minutes} min ago`
      : hours < 48
        ? `read ${hours} h ago`
        : `read ${Math.round(hours / 24)} days ago`;
  return { text, stale: ms > STALE_AFTER_MS };
}

/** A reading asked for at `askedAt` has finished: nothing pending and the last one done after the ask. */
export function readingDone(freshness: FreshnessData, askedAt: number): boolean {
  const section = freshness.section;
  if (!section)
    return (
      !freshness.working &&
      freshness.updatedAt !== null &&
      Date.parse(freshness.updatedAt) >= askedAt
    );
  return (
    section.pending === 0 &&
    section.lastDoneAt !== null &&
    Date.parse(section.lastDoneAt) >= askedAt
  );
}

/** What "Ask the agent to fix it" puts in the conversation. */
export function fixPrompt(issue: Pick<Issue, "title" | "whatToDo" | "subject">): string {
  const tools = issue.subject.tools.map((tool) => tool.label).join(", ");
  return `Help me fix this Ratel Agent health issue: "${issue.title}"${tools ? ` (${tools})` : ""}. Ratel suggests: ${issue.whatToDo}`;
}

/**
 * What the card has been told since its last read: issues the host confirmed
 * hidden (kept until the re-read shows them) and ids shown again.
 */
export interface HiddenEdits {
  hiddenNow: ReadonlyMap<string, Issue>;
  shownAgain: ReadonlySet<string>;
}

export const NO_HIDDEN_EDITS: HiddenEdits = { hiddenNow: new Map(), shownAgain: new Set() };

/** The edits once the host confirmed hiding or showing `id` again. Hiding undoes an earlier "Show again". */
export function applyHiddenEdit(
  edits: HiddenEdits,
  id: string,
  hide: boolean,
  issue?: Issue,
): HiddenEdits {
  const hiddenNow = new Map(edits.hiddenNow);
  const shownAgain = new Set(edits.shownAgain);
  if (hide) {
    if (issue) hiddenNow.set(id, issue);
    shownAgain.delete(id);
  } else {
    hiddenNow.delete(id);
    shownAgain.add(id);
  }
  return { hiddenNow, shownAgain };
}

/** The "Hidden as slow by design" list: the last read's, with the edits since. */
export function hiddenIssuesShown(
  data: Pick<HealthData, "hiddenIssues">,
  edits: HiddenEdits,
): HiddenIssue[] {
  const known = new Set(data.hiddenIssues.map((item) => item.id));
  return [
    ...[...edits.hiddenNow.values()]
      .filter((issue) => !known.has(issue.id))
      .map((issue) => ({
        id: issue.id,
        kind: issue.kind,
        toolId: issue.subject.tools[0]?.id ?? null,
        label: issue.subject.label || issue.title,
      })),
    ...data.hiddenIssues.filter((item) => !edits.shownAgain.has(item.id)),
  ];
}
