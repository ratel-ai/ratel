import type { SiteToolId } from "@/lib/console/seed/site-copilot-catalog";
import type { SitePlan, SiteTurn } from "@/lib/console/seed/site-copilot-plan";
import { hexOf } from "@/lib/console/seed/site-copilot-rng";
import type { AnalystDeps } from "@/lib/synthesis/match-quality/analyst";
import type { AnalystContext } from "@/lib/synthesis/match-quality/context";
import { type GroundTruthLabel, queryKey } from "@/lib/synthesis/match-quality/labels";

/**
 * Match quality for the Site Copilot demo: the tool searches its agent made, an
 * experiment that ranks each one twice, the answer key, and two weekly runs
 * with their rewrites, so Quality's Misses, Descriptions and Experiments show
 * what a customer sees after a month.
 *
 * The story. Site Copilot's agent finds its tools through the customer's own
 * keyword search (the `legacy` variant, which serves), and Ratel ranks every
 * search beside it (`ratel`, in the comparison slot): the experiment a team runs
 * before it switches. Each search is the person's ask, as content capture
 * records it. Ratel's list is the SDK's own BM25 over the catalog's searchable
 * descriptions (`bm25Order`, the ranking the replay scores with), so its misses
 * are the catalog's real vocabulary gaps ("on track or behind", "when does it
 * arrive", "price out CO-044"), and a rewrite that fills one is measured by the
 * same replay that offers it.
 *
 * Pure and deterministic: every id and draw comes from the Site Copilot plan's
 * seed and turn keys. Placing the searches on the calendar needs the stored
 * traces, which `scripts/seed-site-copilot-quality.mts` reads.
 */

/** The experiment's id, as the SDK sends it. */
export const SITE_QUALITY_EXPERIMENT = "tool-search";
/** Ratel's variant: ranked beside the served one. The arm match quality tunes. */
export const SITE_QUALITY_OURS = "ratel";
/** The customer's own keyword search: the variant the agent is shown. */
export const SITE_QUALITY_THEIRS = "legacy";
/** Ratel returns five tools. */
export const OURS_DEPTH = 5;
/** The customer's search cuts its list at three. */
export const THEIRS_DEPTH = 3;
/** Recorded as the answer key's judge. The console never prints it. */
export const SITE_QUALITY_JUDGE_MODEL = "site-copilot-seed-judge";
/** Recorded as the analyst of a run that replays the captured rewrites. */
export const SITE_QUALITY_ANALYST_MODEL = "site-copilot-seed-analyst";
/** The share of distinct asks the answer key has read; the rest wait for a later sweep. */
export const JUDGED_SHARE = 0.9;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/* - Which tool each ask needs --------------------------------------------- */

/** What a search was looking for: a catalog tool, or something no tool does. */
export type SearchAnswer = SiteToolId | "unanswerable";

/** The tool that answers each kind of ask, when the kind alone decides it. */
const BY_KIND: Readonly<Partial<Record<string, SearchAnswer>>> = {
  material_delivery: "track_material_delivery",
  schedule_status: "get_project_schedule",
  schedule_impact: "get_project_schedule",
  spec_question: "search_spec_book",
  change_orders: "estimate_change_order",
  change_order_refine: "estimate_change_order",
  weather_risk: "check_weather_delay",
  rfi_draft: "create_rfi",
  safety_checklist: "get_safety_checklist",
  retainage: "get_pay_application",
  handoff: "notify_team",
  // Nothing in the catalog books a rental or an inspection: a judge reads these
  // and leaves them undecided, and they stay out of every number.
  equipment_rental: "unanswerable",
  inspection_booking: "unanswerable",
};

/**
 * The tool a turn's ask needed, or null when the agent made no search for it.
 *
 * The first tool an agent calls is often a lookup (`list_projects`), so the
 * answer comes from what the ask wants, read from its kind and, where one kind
 * covers two asks, from the tool the agent went on to call. "Try again" retries
 * the failed call without a new search; a plain thanks calls nothing.
 */
export function answerFor(turn: Pick<SiteTurn, "kind" | "topic" | "calls">): SearchAnswer | null {
  const called = new Set(turn.calls.map((call) => call.tool));
  // A correction or a repeated ask wants what the original ask wanted.
  const kind =
    turn.kind === "correction" || turn.kind === "asked_again"
      ? (turn.topic ?? turn.kind)
      : turn.kind;
  switch (kind) {
    case "try_again":
      return null;
    case "thanks":
      return called.has("notify_team") ? "notify_team" : null;
    case "rfis":
      return called.has("get_rfi") ? "get_rfi" : "list_rfis";
    case "safety_report":
      return called.has("log_safety_incident") ? "log_safety_incident" : "get_safety_checklist";
    case "subcontractors":
      return called.has("get_subcontractor_compliance")
        ? "get_subcontractor_compliance"
        : "list_subcontractors";
    case "payment_status":
      return called.has("check_payment_status") ? "check_payment_status" : "get_pay_application";
    case "correction":
    case "asked_again": {
      // No topic to go on: the last tool that was not a lookup.
      const principal = turn.calls
        .map((call) => call.tool)
        .filter((tool) => tool !== "list_projects" && tool !== "get_project_info");
      return principal.at(-1) ?? null;
    }
    default:
      return BY_KIND[kind] ?? null;
  }
}

/* - The searches ----------------------------------------------------------- */

/** The share of searches the SDK skipped (capacity) or dropped (timeout) instead of comparing. */
const SKIPPED_SHARE = 0.025;
const DROPPED_SHARE = 0.01;

export interface SiteSearch {
  /** The turn's key in the plan. */
  key: string;
  traceId: string;
  rootSpanId: string;
  /** The experiment's selection id: one per search. */
  selectionId: string;
  query: string;
  answer: SearchAnswer;
  /** The tools the agent ran for this ask, in first-call order. */
  called: SiteToolId[];
  /** What the SDK recorded: both rankings, or a search it skipped or dropped before comparing. */
  fate: "compared" | "skipped" | "dropped";
}

/** A turn's trace id, as `site-copilot-otlp.ts` derives it. */
export function siteTraceId(seed: number, turnKey: string): string {
  return hexOf(`site-copilot:${seed}:trace:${turnKey}`, 32);
}

/** A turn's root span id (`invoke_agent`), as `site-copilot-otlp.ts` derives it. */
export function siteRootSpanId(seed: number, turnKey: string): string {
  return hexOf(`site-copilot:${seed}:span:${turnKey}:root`, 16);
}

/** A stable draw in [0, 1) for one label. */
export function draw(label: string): number {
  return parseInt(hexOf(`site-copilot-quality:${label}`, 8), 16) / 0x1_0000_0000;
}

/** Every search the plan's agent made, in plan order. */
export function planQualitySearches(plan: SitePlan): SiteSearch[] {
  const searches: SiteSearch[] = [];
  for (const conversation of plan.conversations) {
    for (const turn of conversation.turns) {
      const answer = answerFor(turn);
      if (answer === null) continue;
      const fateDraw = draw(`fate:${turn.key}`);
      searches.push({
        key: turn.key,
        traceId: siteTraceId(plan.seed, turn.key),
        rootSpanId: siteRootSpanId(plan.seed, turn.key),
        selectionId: `sel_${hexOf(`site-copilot-quality:${plan.seed}:selection:${turn.key}`, 24)}`,
        query: turn.ask,
        answer,
        called: [...new Set(turn.calls.map((call) => call.tool))],
        fate:
          fateDraw < SKIPPED_SHARE
            ? "skipped"
            : fateDraw < SKIPPED_SHARE + DROPPED_SHARE
              ? "dropped"
              : "compared",
      });
    }
  }
  return searches;
}

/* - The customer's keyword search ------------------------------------------ */

const STOPWORDS = new Set(
  "the a an and or of for to in on at is are be was were it its this that with from by as can you your my our we i me do does did has have had what whats when where who how any about there their they them not no yes up out get".split(
    " ",
  ),
);

function keywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));
  return [...new Set(words)];
}

export interface RankableTool {
  entryId: string;
  name: string;
  searchable: string;
}

/**
 * The `legacy` variant: a plain keyword match over each tool's name and
 * description, the most shared words first and catalog order breaking ties. No
 * weighting, so a word every description shares counts as much as a rare one,
 * which is how it ranks a lookup above the tool the ask needed.
 */
export function keywordSearch(
  tools: readonly RankableTool[],
): (query: string, depth: number) => string[] {
  const index = tools.map((tool, order) => ({
    id: tool.entryId,
    order,
    words: new Set([...keywords(tool.name.replace(/_/g, " ")), ...keywords(tool.searchable)]),
  }));
  return (query, depth) => {
    const asked = keywords(query);
    return index
      .map((tool) => ({ ...tool, score: asked.filter((word) => tool.words.has(word)).length }))
      .filter((tool) => tool.score > 0)
      .sort((left, right) => right.score - left.score || left.order - right.order)
      .slice(0, depth)
      .map((tool) => tool.id);
  };
}

/* - What the SDK sends ------------------------------------------------------ */

/** One search placed on the calendar, with what both variants returned. */
export interface SearchSighting {
  search: SiteSearch;
  at: Date;
  /** Ratel's list. */
  ours: readonly string[];
  /** The customer's list: the one the agent saw. */
  theirs: readonly string[];
}

type OtlpValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpValue[] } };

export interface OtlpLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  eventName: string;
  traceId: string;
  spanId: string;
  attributes: { key: string; value: OtlpValue }[];
}

type AttrInput = string | boolean | number | readonly string[] | readonly number[];

function otlpValue(value: AttrInput, double = false): OtlpValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number")
    return double || !Number.isInteger(value)
      ? { doubleValue: value }
      : { intValue: String(value) };
  return { arrayValue: { values: value.map((item) => otlpValue(item, typeof item === "number")) } };
}

function record(
  eventName: string,
  at: number,
  search: SiteSearch,
  attributes: Record<string, AttrInput>,
  doubles: readonly string[] = [],
): OtlpLogRecord {
  const nanos = `${Math.round(at)}000000`;
  return {
    timeUnixNano: nanos,
    observedTimeUnixNano: nanos,
    severityNumber: 9,
    severityText: "INFO",
    eventName,
    traceId: search.traceId,
    spanId: search.rootSpanId,
    attributes: Object.entries(attributes).map(([key, value]) => ({
      key,
      value: otlpValue(value, doubles.includes(key)),
    })),
  };
}

/** Descending scores for a list, the way each engine reports them: BM25 tails off, the keyword match steps. */
function scoresFor(list: readonly string[], label: string, step: number, top: number): number[] {
  const start = top + draw(label) * 2;
  return list.map((_, index) => Math.round((start - index * step) * 1000) / 1000);
}

/** How much two lists agree, as the SDK stamps it on a comparison. */
export function agreement(served: readonly string[], shadow: readonly string[], k: number) {
  const left = served.slice(0, k);
  const right = shadow.slice(0, k);
  const overlap = left.filter((id) => right.includes(id)).length;
  const union = new Set([...left, ...right]).size;
  return {
    top1: left.length > 0 && left[0] === right[0],
    exactOrder: left.length === right.length && left.every((id, index) => right[index] === id),
    overlap,
    jaccard: union === 0 ? 1 : overlap / union,
  };
}

/**
 * The records one search leaves: a comparison and both variants' results, plus
 * the agent's call when the SDK could tie it to this search (the tool the ask
 * needed, run from the list it was shown). A skipped or dropped search leaves
 * only its lifecycle record. Every record carries a stable `ratel.event.id`, so
 * sending it again stores nothing new.
 */
export function sightingRecords(sighting: SearchSighting): OtlpLogRecord[] {
  const { search, ours, theirs } = sighting;
  const at = sighting.at.getTime();
  const base = {
    "ratel.experiment.id": SITE_QUALITY_EXPERIMENT,
    "ratel.experiment.selection_id": search.selectionId,
  };
  const id = (event: string) => `site-copilot-quality:${search.key}:${event}`;
  if (search.fate !== "compared") {
    const event = search.fate === "skipped" ? "skip" : "drop";
    return [
      record(`ratel.experiment.${event}`, at, search, {
        ...base,
        "ratel.event.id": id(event),
        "ratel.experiment.arm": SITE_QUALITY_OURS,
        "ratel.experiment.role": "shadow",
        "ratel.experiment.query": search.query,
        ...(search.fate === "skipped"
          ? { "ratel.experiment.skip.reason": "capacity" }
          : { "ratel.experiment.drop.reason": "timeout" }),
      }),
    ];
  }

  const servedMs = Math.round(140 + draw(`served-ms:${search.key}`) * 420);
  const shadowMs = Math.round(18 + draw(`shadow-ms:${search.key}`) * 44);
  const agreed = agreement(theirs, ours, OURS_DEPTH);
  const records: OtlpLogRecord[] = [
    record(
      "ratel.experiment.results",
      at + servedMs,
      search,
      {
        ...base,
        "ratel.event.id": id("results:legacy"),
        "ratel.experiment.arm": SITE_QUALITY_THEIRS,
        "ratel.experiment.role": "serving",
        "ratel.experiment.result_ids": theirs,
        "ratel.experiment.result_scores": scoresFor(theirs, `legacy-score:${search.key}`, 1, 4),
      },
      ["ratel.experiment.result_scores"],
    ),
    record(
      "ratel.experiment.results",
      at + shadowMs,
      search,
      {
        ...base,
        "ratel.event.id": id("results:ratel"),
        "ratel.experiment.arm": SITE_QUALITY_OURS,
        "ratel.experiment.role": "shadow",
        "ratel.experiment.result_ids": ours,
        "ratel.experiment.result_scores": scoresFor(ours, `ratel-score:${search.key}`, 0.9, 8),
      },
      ["ratel.experiment.result_scores"],
    ),
    record(
      "ratel.experiment.comparison",
      at + Math.max(servedMs, shadowMs) + 2,
      search,
      {
        ...base,
        "ratel.event.id": id("comparison"),
        "ratel.experiment.arm": SITE_QUALITY_OURS,
        "ratel.experiment.role": "shadow",
        "ratel.experiment.query": search.query,
        "ratel.experiment.served.arm": SITE_QUALITY_THEIRS,
        "ratel.experiment.shadow.arm": SITE_QUALITY_OURS,
        "ratel.experiment.served.outcome": theirs.length > 0 ? "ok" : "empty",
        "ratel.experiment.shadow.outcome": ours.length > 0 ? "ok" : "empty",
        "ratel.experiment.served.duration_ms": servedMs,
        "ratel.experiment.shadow.duration_ms": shadowMs,
        "ratel.experiment.served.hit_count": theirs.length,
        "ratel.experiment.shadow.hit_count": ours.length,
        "ratel.experiment.agreement.k": OURS_DEPTH,
        "ratel.experiment.agreement.top1": agreed.top1,
        "ratel.experiment.agreement.exact_order": agreed.exactOrder,
        "ratel.experiment.agreement.overlap_count": agreed.overlap,
        "ratel.experiment.agreement.jaccard_at_k": agreed.jaccard,
      },
      ["ratel.experiment.agreement.jaccard_at_k"],
    ),
  ];

  // The agent has every tool in its prompt, so it can run the one it needs even
  // when the list it was shown missed it: the SDK records where that tool sat
  // in the served list (0-based, -1 for "not in it"), and, like today's SDK,
  // not which tool it was.
  if (search.answer !== "unanswerable" && search.called.includes(search.answer)) {
    const ageMs = Math.round(600 + draw(`age:${search.key}`) * 5_400);
    records.push(
      record("ratel.experiment.invocation", at + servedMs + ageMs, search, {
        ...base,
        "ratel.event.id": id("invocation"),
        "ratel.experiment.arm": SITE_QUALITY_THEIRS,
        "ratel.experiment.role": "serving",
        "ratel.experiment.invocation.attributed": true,
        "ratel.experiment.invocation.rank": theirs.indexOf(search.answer),
        "ratel.experiment.invocation.age_ms": ageMs,
        "ratel.experiment.effective_arm": SITE_QUALITY_THEIRS,
      }),
    );
  }
  return records;
}

/** One OTLP/JSON logs export from Site Copilot's SDK. */
export function logsExport(records: readonly OtlpLogRecord[]): object {
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "site-copilot" } }] },
        scopeLogs: [{ scope: { name: "@ratel-ai/sdk" }, logRecords: records }],
      },
    ],
  };
}

/* - The answer key ---------------------------------------------------------- */

/**
 * The answer key a judge would leave after reading these searches: one row per
 * distinct ask. An ask no tool answers is read and left unclear; nine in ten of
 * the rest are judged, with the tool the ask needed, a confidence and the
 * sibling it is confused with, and the others wait for a later sweep. The SDK
 * records where the agent's tool sat but not which tool it was, so no answer
 * comes from seeing it run.
 */
export function answerKeyLabels(
  sightings: readonly SearchSighting[],
  meta: { judgedAt: Date; fingerprint: string | null },
): GroundTruthLabel[] {
  const byKey = new Map<string, { last: SearchSighting; count: number }>();
  for (const sighting of sightings) {
    const key = queryKey(sighting.search.query);
    if (key === null) continue;
    const seen = byKey.get(key);
    byKey.set(key, {
      last: seen && seen.last.at.getTime() > sighting.at.getTime() ? seen.last : sighting,
      count: (seen?.count ?? 0) + 1,
    });
  }

  const labels: GroundTruthLabel[] = [];
  for (const [key, { last, count }] of byKey) {
    const { search } = last;
    const shared = {
      queryKey: key,
      query: search.query,
      model: SITE_QUALITY_JUDGE_MODEL,
      selectionId: search.selectionId,
      occurrences: count,
      observedAt: meta.judgedAt,
      catalogFingerprint: meta.fingerprint,
    };
    if (search.answer === "unanswerable") {
      labels.push({
        ...shared,
        entryId: "",
        source: "unclear",
        confident: false,
        confidence: null,
        runnerUp: null,
      });
      continue;
    }
    if (draw(`judged:${key}`) >= JUDGED_SHARE) continue;
    const confidence = Math.round((0.62 + draw(`confidence:${key}`) * 0.36) * 100) / 100;
    const runnerUp = [...last.ours, ...last.theirs].find((id) => id !== search.answer) ?? null;
    labels.push({
      ...shared,
      entryId: search.answer,
      source: "judge",
      confident: confidence >= 0.7,
      confidence,
      runnerUp,
    });
  }
  return labels;
}

/* - The runs ---------------------------------------------------------------- */

export interface RunSlot {
  createdAt: Date;
  windowStart: Date;
  windowEnd: Date;
  windowDays: number;
}

export interface QualityTimeline {
  /** The weekly run two weeks before the latest. */
  earlier: RunSlot;
  /** When someone applied one of the earlier run's rewrites (and dismissed another). */
  actedAt: Date;
  /** The latest weekly run, just after the last search. */
  latest: RunSlot;
}

const RUN_WINDOW_DAYS = 14;

/** Two 14-day runs ending just after the last search, with the operator's visit a day after the first. */
export function qualityTimeline(lastSearchAt: Date): QualityTimeline {
  const latestAt = Math.ceil(lastSearchAt.getTime() / MINUTE_MS) * MINUTE_MS + 20 * MINUTE_MS;
  const slot = (at: number): RunSlot => ({
    createdAt: new Date(at),
    windowStart: new Date(at - RUN_WINDOW_DAYS * DAY_MS),
    windowEnd: new Date(at),
    windowDays: RUN_WINDOW_DAYS,
  });
  const earlierAt = latestAt - RUN_WINDOW_DAYS * DAY_MS;
  return {
    earlier: slot(earlierAt),
    actedAt: new Date(earlierAt + 26 * HOUR_MS),
    latest: slot(latestAt),
  };
}

/** When a turn's search happened: just after the ask reached the agent. */
export function searchTime(rootStartedAt: Date): Date {
  return new Date(rootStartedAt.getTime() + 250);
}

/** One drafted rewrite, as the analyst writes it. */
export interface CapturedRewrite {
  searchableDescription: string;
  rationale: string;
  details: string;
  expectedEffect: string;
}

/** What the analyst answered for one run: its read of the catalog and a rewrite per tool. */
export interface CapturedRun {
  diagnosis: string;
  points: { title: string; detail: string }[];
  rewrites: Readonly<Record<string, CapturedRewrite>>;
}

/**
 * The analyst for a seeded run: it answers with what a real analysis of these
 * same searches answered (`site-copilot-quality-fixture.ts`), siblings it
 * rewrote alongside the nominated tools included. The prompt is still built
 * and the answer still parsed and replayed, so everything after the model call
 * is the pipeline's own. The run is stored as `mocked`.
 */
export function replayAnalyst(context: AnalystContext, captured: CapturedRun): AnalystDeps {
  const known = new Set(context.corpus.map((entry) => entry.entryId));
  return {
    model: SITE_QUALITY_ANALYST_MODEL,
    complete: async () =>
      JSON.stringify({
        diagnosis: { headline: captured.diagnosis, points: captured.points },
        proposals: Object.entries(captured.rewrites)
          .filter(([entryId]) => known.has(entryId))
          .map(([entryId, rewrite]) => ({ entryId, ...rewrite })),
      }),
  };
}

/**
 * The console never prints an em dash (DESIGN.md, Content), and a model writes
 * plenty: a pair around an aside becomes parentheses, a single one a colon.
 * Captured text is still worth a read before it is committed.
 */
export function withoutEmDashes(text: string): string {
  return text
    .replace(/\s*\u2014\s*([^\u2014.]*?)\s*\u2014\s*/g, " ($1) ")
    .replace(/\s*\u2014\s*/g, ": ")
    .replace(/ \(([^)]*)\) ([,.;:])/g, " ($1)$2");
}

/** After the earlier run, the operator applies one rewrite and dismisses another. */
export const APPLIED_AFTER_EARLIER = "estimate_change_order";
export const DISMISSED_AFTER_EARLIER = "notify_team";
