import type { TaskColorSlot } from "@ratel/design-system/task-colors";
import type { CraftKind, EffectChip, EvidenceFact } from "@/lib/views/fixes/crafter-types";
import type { FixGroup } from "@/lib/views/fixes/groups";
import type { FixKind } from "@/lib/views/fixes/kinds";
import type { SuggestionRow } from "@/lib/views/quality/suggestions";

/**
 * One Fix: a concrete change that would make the agent better, whichever
 * engine found it. Every source (a drafted change of Tasks, a rewrite of
 * Quality, an issue of Agent health that names a change) becomes this shape,
 * so Fixes, a task's page, a topic's panel and the Overview read one model.
 *
 * Plain, serializable data: the page hands it to the client as is.
 */

/**
 * Which engine the fix came from. Never shown; it decides the actions that
 * exist. `intent`: an intent's own numbers (a skill for an intent no skill
 * covers, `skill-gaps.ts`).
 */
export type FixSource = "rewrite" | "craft" | "issue" | "intent";

/** `applied` exists only for rewrites, the one change Cloud makes itself. */
export type FixStatus = "open" | "applied";

export interface FixToolRef {
  id: string;
  label: string;
  /** The tool on Catalog. */
  href: string;
}

export interface FixTaskRef {
  id: string;
  label: string;
  /** The task's color slot when it is one of the busiest three; null wears neutral. */
  color: TaskColorSlot | null;
  href: string;
}

export interface FixTopicRef {
  id: string;
  label: string;
  href: string;
}

/** What the fix touches: tools, the tasks that run them, the topics those serve. */
export interface FixSubject {
  tools: FixToolRef[];
  tasks: FixTaskRef[];
  topics: FixTopicRef[];
}

/** An issue the fix resolves, as Agent health states it. */
export interface FixIssueRef {
  id: string;
  kind: string;
  /** Three to six plain words: "Wrong tool keeps showing up". */
  title: string;
  /** The claim with its numbers. */
  claim: string;
  /** What it costs today, one sentence. */
  cost: string;
  /** Its headline figure, the number Agent health shows on its row: "41%" and "of lists". */
  figure: { display: string; caption: string } | null;
  href: string;
}

/** What making the fix would do, from the source's own measurement. */
export interface FixEffect {
  /** The one compact effect a row shows: "+40 pts found", "3 → 1 calls", "−1 failed call". */
  value: string;
  /** `value`'s figure, set large in the Panel: "+40 pts", "3 → 1", "−1". */
  figure: string;
  /** `value`'s unit beside it: "found", "calls", "failed call"; empty when the figure says it all. */
  unit: string;
  /** The counts behind it, for the Panel: "3 → 5 of 5 searches", "−123 model calls in all". */
  detail: string | null;
  /** Good, bad or no change for the reader. */
  tone: "good" | "bad" | "neutral";
  /** A replay of past searches, or the agent's own runs. */
  basis: "replay" | "runs";
  /** The other numbers it moves, shown as marks beside the headline in the row; the headline is not repeated. */
  also: EffectReading[];
}

/** One more number a fix moves: the mark a row shows, and the whole reading for its tooltip. */
export interface EffectReading {
  icon: EffectChip["icon"];
  /** "−686 ms/request waiting", with how it adds up when the source said: "40 model calls × $0.0095 per model call". */
  label: string;
}

/** What the fix saves over the window, when the source measured it; summed with care (`fixStats`). */
export interface FixGain {
  roundTrips: number;
  calls: number;
  ms: number;
}

export type EvidenceStrength = "early" | "solid" | "strong";

export interface FixEvidence {
  strength: EvidenceStrength;
  /** "Early", "Solid", "Strong". */
  label: string;
  /** What it stands on: "Missed 9 searches · Seen it run", "Seen 69 times in this window". */
  detail: string;
}

/** Only the actions that really work for this fix's source. */
export interface FixActions {
  /** Apply a rewrite (Cloud writes the searchable description override). */
  apply: boolean;
  dismiss: boolean;
  /** Put an applied rewrite back. */
  revert: boolean;
  /** The one tool on Catalog, for single-tool fixes. */
  catalogHref: string | null;
  /** The change as text to paste into the customer's own agent or code. */
  copy: { label: string; text: string } | null;
  /**
   * For a description fix, Quality › Descriptions, where it is applied: the
   * rewrite open when there is one, else its tool. Null for every other group.
   */
  descriptionHref: string | null;
}

/** A rewrite's panel: Quality's before and after, reused as is. */
export interface RewriteDetail {
  source: "rewrite";
  row: SuggestionRow;
  /** Said beside Apply when nothing has fetched the overrides recently. */
  caveat: string | null;
}

/** A drafted change's panel: what it is, what it is worth, and the change to paste. */
export interface CraftDetail {
  source: "craft";
  /** The drafted kind, for its small drawing of the change (KindMotion). */
  craftKind: CraftKind;
  /** What this kind of change is, in one or two plain sentences. */
  plain: string;
  /** Up to three facts with their numbers. */
  why: string[];
  /** What one application removes, then the window's totals. */
  worth: EffectChip[];
  /** What the totals count: "over the window · 41 runs"; null when nothing is counted. */
  worthCaption: string | null;
  replay: { verdict: "better" | "same" | "worse"; delta: string | null } | null;
  /** The steps on the customer's side, in plain words. */
  change: string[];
  facts: EvidenceFact[];
  /** The tools involved, as the agent declares them today. */
  sources: { id: string; name: string; description: string }[];
  /** The drafted definitions to ship (JSON, and TypeScript and Python stubs); empty for kinds that are a note. */
  crafted: { name: string; json: string; typescript: string; python: string }[];
}

/** An issue-only fix's panel: the change Agent health names. */
export interface IssueDetail {
  source: "issue";
  /** Each issue's "What to do" sentence, once each. */
  changes: string[];
  caveat: string | null;
}

/** An intent's own fix: the change in plain words, and the steps the skill would run. */
export interface IntentDetail {
  source: "intent";
  /** The change, one line each. */
  changes: string[];
  /** The steps, in their usual order (catalog tool ids; the subject's pins carry their names). */
  steps: string[];
  caveat: string | null;
}

export type FixDetail = RewriteDetail | CraftDetail | IssueDetail | IntentDetail;

export interface Fix {
  /** `rewrite:<proposal id>`, `craft:<proposal id>`, `issue:<issue id>` or `intent:<intent id>`. */
  id: string;
  source: FixSource;
  sourceId: string;
  /** Other ids that open this fix: a merged draft, and `issue:<id>` of each issue it resolves. */
  aliases: string[];
  /** Verb first, plain: "Rewrite lookup_order's searchable description". */
  title: string;
  /** The title without names, for rows and panels that show them as pins: "Merge 2 tools into one". */
  short: string;
  /** One line with its numbers: the issue it resolves, else the source's own evidence. */
  why: string;
  kind: FixKind;
  kindLabel: string;
  /** What a person does with it, the table it is listed in (`groups.ts`). */
  group: FixGroup;
  status: FixStatus;
  subject: FixSubject;
  /**
   * The intent the fix was found in, for "for {Intent}": an intent's own
   * two-tool merge, or a skill for an intent no skill covers. Absent for
   * every other fix, and when the intent's name could not be read.
   */
  intent?: FixTopicRef;
  effect: FixEffect | null;
  gain: FixGain | null;
  evidence: FixEvidence | null;
  issues: FixIssueRef[];
  actions: FixActions;
  detail: FixDetail;
  /**
   * Biggest effect first (`compareFixes`): tier 0 has a measured effect on
   * solid evidence and `score` is how often it applies; tier 1 resolves an
   * issue and `score` is the worst issue's severity, `count` its size; tier 2
   * is measured on early evidence; tier 3 has neither; tier 4 measured worse.
   */
  rank: { tier: number; score: number; count: number };
  /** ISO time the rewrite was applied, for the Applied list. */
  appliedAt: string | null;
}

export interface FixStats {
  /** Open fixes. */
  open: number;
  /** Open fixes Cloud can apply itself. */
  ready: number;
  /** Open fixes that resolve at least one issue, and the distinct issues they resolve. */
  fromIssues: number;
  issues: number;
  /** Distinct tools the open fixes touch. */
  tools: number;
  /** Model round trips the open fixes save over their window, overlapping fixes counted once; null when none measured any. */
  roundTripsSaved: number | null;
  /** Open fixes by the strength of their evidence; `none` has no evidence to weigh. */
  evidence: Record<EvidenceStrength | "none", number>;
}

/** Everything Fixes renders. */
export interface FixesModel {
  projectId: string;
  /** Biggest effect first. */
  open: Fix[];
  /** Rewrites already applied, newest first: they can still be reverted. */
  applied: Fix[];
  stats: FixStats;
  /** Sources that could not be read; the rest still renders. */
  failed: FixSource[];
  /** Whether description rewrites can appear at all (Quality is on and on the plan). */
  rewritesOn: boolean;
  /** True only when a runtime fetched the overrides recently, so an applied rewrite reaches the agent. */
  overridesAdopted: boolean | null;
}
