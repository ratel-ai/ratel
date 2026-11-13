import { SIGNAL_CATALOG } from "@/lib/readings/trace-signals/signals/catalog";
import type {
  ClaimSegment,
  EvidenceChart,
  Interval,
  SignalFigure,
  SignalFixRoute,
  SignalKind,
  SignalStatus,
  SignalSubject,
  SignalSubjectKind,
  SignalTier,
  SubjectChip,
  TurnSourceMix,
} from "@/lib/readings/trace-signals/view";
import {
  type WorkflowLabels,
  workflowDisplayName,
} from "@/lib/readings/trace-signals/workflows/name";
import {
  type Ctx,
  count,
  duration,
  type KindCopy,
  num,
  plural,
  share,
  shareText,
  waiting,
} from "@/lib/views/health/signals/claims-kit";
import { OTEL_COPY } from "@/lib/views/health/signals/claims-otel";
import { SELF_CORRECTION_COPY } from "@/lib/views/health/signals/claims-self-corrections";
import { WORKFLOW_COPY } from "@/lib/views/health/signals/claims-workflow";

export { duration, shareText } from "@/lib/views/health/signals/claims-kit";

/**
 * A stored signal told in words: the claim sentence (with subject chips), the
 * big figure and its raw count, the cost line, the "What to do" line and a
 * caveat. Data-side and pure: numbers come from the row's `metrics`, names
 * from the catalog at render time (never from the row). UI formatting of these
 * strings is `claims.ts` (lane E1); this module only decides what they say.
 *
 * House rules: whole percents, at most one decimal anywhere, no em dashes.
 */

/** A `trace_signals` row, parsed. */
export interface SignalRecord {
  id: string;
  kind: SignalKind;
  status: SignalStatus;
  tier: SignalTier;
  subjectKind: SignalSubjectKind;
  subjectKey: string;
  subjectIds: readonly string[];
  entryKind: "tool" | "skill";
  severity: number;
  impact: number;
  n: number;
  metrics: Readonly<Record<string, unknown>>;
  turnIds: readonly string[];
  traceEventIds: readonly (string | null)[];
  totalTurns: number;
  turnSourceMix: TurnSourceMix;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ClaimModel {
  subject: SignalSubject;
  claim: string;
  claimSegments: ClaimSegment[];
  figure: SignalFigure;
  cost: string;
  fix: string;
  fixRoute: SignalFixRoute;
  caveat: string | null;
  interval: Interval | null;
  chart: EvidenceChart | null;
}

const COPY: Record<SignalKind, (c: Ctx) => KindCopy> = {
  first_try_miss: ({ m, name, a, period, route }) => ({
    parts: ["The agent had to search again for the same thing before it found ", { chip: a }, "."],
    figure: share(
      num(m, "share"),
      `${count(num(m, "k"))} of ${count(num(m, "n"))} turns`,
      num(m, "k"),
      num(m, "n"),
    ),
    cost: `${plural(num(m, "extraSearches"), "extra search", "extra searches")} ${period}.`,
    fix:
      route === "adaptive_ranking"
        ? `Have Ratel rank ${name(a)} higher for asks like these. It was in the first list, just too low to be picked.`
        : `Rewrite ${name(a)}'s description with the words people use when they need it.`,
  }),
  buried_tool: ({ m, name, a }) => ({
    parts: [
      { chip: a },
      ` is the right tool and sits at #${count(num(m, "medianRank"))} when picked.`,
    ],
    figure: {
      value: num(m, "medianRank"),
      unit: "rank",
      display: `#${count(num(m, "medianRank"))}`,
      raw: `${count(num(m, "k"))} of ${count(num(m, "n"))} picks below #${count(num(m, "minRank", 4) - 1)}`,
    },
    cost: `${plural(num(m, "k"), "turn", "turns")} read ${count(num(m, "minRank", 4) - 1)} or more hits before reaching it.`,
    fix: `Have Ratel rank ${name(a)} higher for asks like these, then tighten its description.`,
  }),
  magnet: ({ m, name, a, period }) => {
    const impressions = num(m, "impressions");
    const searches = num(m, "searches");
    const listed = shareText(
      impressions,
      searches > 0 ? Math.max(searches, impressions) : 0,
      num(m, "listShare"),
    );
    const picks = num(m, "picks");
    const picked =
      picks > 0
        ? `is picked in ${shareText(picks, impressions, num(m, "pickShare"))}`
        : "is never picked";
    return {
      parts: [{ chip: a }, ` rides into ${listed} of lists and ${picked}.`],
      figure: {
        ...share(
          num(m, "listShare"),
          `${count(impressions)} lists · ${plural(picks, "pick", "picks")}`,
        ),
        display: listed,
      },
      cost: `Took a top-3 slot in ${plural(num(m, "impressionsTop3"), "search", "searches")} ${period}.`,
      fix: `Narrow ${name(a)}'s description to what it really does, so it stops matching searches meant for other tools.`,
    };
  },
  dead_tool: ({ m }) => ({
    parts: [
      num(m, "dead") === 1
        ? "1 tool was never listed and never run."
        : `${count(num(m, "dead"))} tools were never listed and never run.`,
    ],
    figure: {
      value: num(m, "dead"),
      unit: "count",
      display: count(num(m, "dead")),
      raw: `of ${count(num(m, "catalogTools"))} tools`,
    },
    cost: "Each one still takes space in the catalog the agent searches.",
    fix: "Retire them, or merge each into a tool that does get used.",
  }),
  sequence_chain: ({ m, name, a, b, period, route }) => ({
    parts: [
      { chip: a },
      " precedes ",
      { chip: b },
      ` in ${shareText(num(m, "n"), num(m, "turnsB"), num(m, "shareOfB"))} of the turns that run ${name(b)}.`,
    ],
    figure: share(
      num(m, "shareOfB"),
      `${count(num(m, "n"))} of ${count(num(m, "turnsB"))} turns`,
      num(m, "n"),
      num(m, "turnsB"),
    ),
    cost:
      num(m, "viaSearch") > 0
        ? `${count(num(m, "viaSearch"))} of these chains needed a second search to reach ${name(b)} ${period}.`
        : `The two ran together in ${plural(num(m, "n"), "turn", "turns")} ${period}.`,
    fix:
      route === "workflow_skill"
        ? `Write a skill that runs ${name(a)} and ${name(b)} as one step.`
        : `Nothing to change yet. The agent reaches ${name(b)} without searching again.`,
    caveat:
      m.relation === "co_occurrence"
        ? "The two also run in the other order, so this is a habit more than a dependency."
        : undefined,
  }),
  sibling_confusion: ({ m, a, b, name }) => ({
    parts: [{ chip: a }, " and ", { chip: b }, " are shown together and picked at random."],
    figure: {
      value: num(m, "swaps"),
      unit: "count",
      display: count(num(m, "swaps")),
      raw: `swaps in ${plural(num(m, "decisionTurns"), "turn", "turns")}`,
    },
    cost: `${plural(num(m, "swaps"), "turn", "turns")} ran both before settling.`,
    fix: `Rewrite both descriptions to say when to use ${name(a)} and when to use ${name(b)}.`,
    caveat:
      "Which of the two was right is not counted here. The swaps only show the agent could not tell them apart.",
  }),
  error_loop: ({ m, name, a, period }) => ({
    parts: [{ chip: a }, " fails and is retried in the same turn."],
    figure: {
      value: num(m, "errors"),
      unit: "count",
      display: count(num(m, "errors")),
      raw: `errors · ${plural(num(m, "loopTurns"), "looping turn", "looping turns")}`,
    },
    cost: `${plural(num(m, "errors"), "failed call", "failed calls")} ${period}, ${count(num(m, "retries"))} of them retries of a call that had just failed.`,
    fix: `Show these turns to whoever owns ${name(a)}. The retries repeat a call that just failed.`,
  }),
  no_follow_through: ({ m, name, a, period }) => ({
    parts: ["After running ", { chip: a }, ", the agent searched again for the same thing."],
    figure: share(
      num(m, "share"),
      `${count(num(m, "k"))} of ${count(num(m, "n"))} calls`,
      num(m, "k"),
      num(m, "n"),
    ),
    cost: `${plural(num(m, "k"), "extra search", "extra searches")} straight after it answered ${period}.`,
    fix: `Rewrite ${name(a)}'s description to say exactly what it returns, so the agent stops expecting something else.`,
  }),
  abandoned_search: ({ m, period }) => ({
    parts: [
      `${shareText(num(m, "abandoned"), num(m, "turns"), num(m, "share"))} of searches led to no tool call.`,
    ],
    figure: share(
      num(m, "share"),
      `${count(num(m, "abandoned"))} of ${count(num(m, "turns"))} turns`,
      num(m, "abandoned"),
      num(m, "turns"),
    ),
    cost: `${plural(num(m, "abandoned"), "turn", "turns")} searched and ran nothing ${period}.`,
    fix: "Look for a missing tool or skill. A skill can cover asks the catalog does not.",
    caveat: "Some of these may have been answered without a tool.",
  }),
  padding_share: ({ m, route }) => {
    const junk = typeof m.junkShare === "number";
    const cutoff = count(num(m, "pickCutoff", 5));
    const topK = count(num(m, "medianTopK"));
    return {
      // The sentence states the same measure the big figure shows, so the card
      // never puts two different percentages side by side as if they agreed.
      parts: [
        junk
          ? `Lists are filled to ${topK}, and ${shareText(num(m, "junkHits"), num(m, "scoredHits"), num(m, "junkShare"))} of what they show scores far below the top hit.`
          : `Lists are filled to ${topK}; picks below #${cutoff} are ${shareText(num(m, "picksBelowCutoff"), num(m, "picks"), num(m, "belowCutoffShare"))}.`,
      ],
      figure: junk
        ? {
            ...share(
              num(m, "junkShare"),
              `${count(num(m, "junkHits"))} of ${count(num(m, "scoredHits"))} hits`,
              num(m, "junkHits"),
              num(m, "scoredHits"),
            ),
            caption: "weak results",
          }
        : share(
            num(m, "belowCutoffShare"),
            `${count(num(m, "picksBelowCutoff"))} of ${count(num(m, "picks"))} picks`,
            num(m, "picksBelowCutoff"),
            num(m, "picks"),
          ),
      cost: junk
        ? `About ${count(num(m, "junkHits"))} hits the agent read and never needed; it picked below #${cutoff} in ${shareText(num(m, "picksBelowCutoff"), num(m, "picks"), num(m, "belowCutoffShare"))} of its picks.`
        : `About ${count(num(m, "picks") - num(m, "picksBelowCutoff"))} picks came from the top ${cutoff}.`,
      fix:
        route === "lower_top_k"
          ? `Return ${count(num(m, "suggestedTopK"))} results per search instead. The agent rarely picks below #${cutoff}, and every extra hit costs tokens.`
          : "Tighten the searchable descriptions so fewer weak matches score close to the top.",
      caveat: junk ? "Junk is estimated from score gaps, not judged." : undefined,
    };
  },
  latency_outlier: ({ m, name, a }) => ({
    parts: [
      { chip: a },
      `'s slowest calls take ${duration(num(m, "p95Ms"))}, against ${duration(num(m, "medianMs"))} for a typical call.`,
    ],
    figure: {
      value: num(m, "p95Ms"),
      unit: "ms",
      display: duration(num(m, "p95Ms")),
      raw: `slowest 5% of ${plural(num(m, "calls"), "call", "calls")}`,
    },
    cost: `${waiting((num(m, "calls") * Math.max(0, num(m, "p95Ms") - num(m, "medianMs"))) / 1_000)}.`,
    fix: `Nothing to change in the catalog. The time is spent inside ${name(a)}.`,
  }),
  unstable_intent: ({ m }) => ({
    parts: [`The same ask resolves to ${count(num(m, "distinct"))} different tools.`],
    figure: share(
      num(m, "topShare"),
      `top tool in ${count(num(m, "top"))} of ${count(num(m, "n"))}`,
      num(m, "top"),
      num(m, "n"),
    ),
    cost: `${plural(num(m, "n") - num(m, "top"), "turn", "turns")} started on a tool the rest of this ask did not use.`,
    fix: "Let Ratel learn which tool this ask needs, so the one that worked before comes first.",
    caveat: "Grouped by exact query match; near phrasings are not merged yet.",
  }),
  repeat_invoke: ({ m, a, period }) => ({
    parts: [{ chip: a }, ` is called ${count(num(m, "minCalls", 3))} or more times in one turn.`],
    figure: {
      value: num(m, "k"),
      unit: "count",
      display: count(num(m, "k")),
      raw: `of ${plural(num(m, "n"), "turn", "turns")}`,
    },
    cost: `${plural(num(m, "extraCalls"), "extra call", "extra calls")} ${period}.`,
    fix: "Look at the turns. Telling identical repeats from real follow-ups needs content capture.",
  }),
  fragmented_intents: ({ m }) => ({
    parts: [`${count(num(m, "singletons"))} of ${count(num(m, "clusters"))} asks stand alone.`],
    figure: share(
      num(m, "share"),
      `${count(num(m, "singletons"))} of ${count(num(m, "clusters"))}`,
      num(m, "singletons"),
      num(m, "clusters"),
    ),
    cost: "Ratel cannot learn from an ask it has only seen once.",
    fix: "Group repeated asks together so Ratel can learn from them.",
    caveat: "Read from the stored intent graph, not from this window's turns.",
  }),
  cooccurring_intents: ({ m, a, b }) => ({
    parts: [{ chip: a }, " and ", { chip: b }, " are asked for in the same turn."],
    figure: { value: num(m, "n"), unit: "count", display: count(num(m, "n")), raw: "turns" },
    cost: `${plural(num(m, "n"), "turn", "turns")} asked for both.`,
    fix: "Write a skill that covers both asks.",
  }),
  ...OTEL_COPY,
  ...WORKFLOW_COPY,
  ...SELF_CORRECTION_COPY,
};

const INFERRED_CAVEAT = "Turn boundaries here are inferred from timing, not declared by the SDK.";

function mostlyInferred(mix: TurnSourceMix): boolean {
  const total = mix.declared + mix.inferred + mix.otlp;
  return total > 0 && mix.inferred * 2 > total;
}

const ROUTES: ReadonlySet<string> = new Set([
  "rewrite_description",
  "adaptive_ranking",
  "retire_tool",
  "workflow_skill",
  "disambiguate_pair",
  "lower_top_k",
  "show_turns",
  "run_extraction",
  "none",
]);

/**
 * The words and figure a stored signal renders with. `windowDays` is the span
 * its "in the last N days" lines claim: the evidence span of the run that
 * found it (see `evidenceSpanDays`), never a window with days the project had
 * not sent turns in yet.
 */
export function claimModel(
  record: SignalRecord,
  names: ReadonlyMap<string, string>,
  windowDays: number,
  labels?: WorkflowLabels,
): ClaimModel {
  const m = record.metrics;
  const stored =
    typeof m.route === "string" && ROUTES.has(m.route) ? (m.route as SignalFixRoute) : null;
  const route = stored ?? SIGNAL_CATALOG[record.kind].fixRoute;
  const name = (id: string | undefined) => (id ? (names.get(id) ?? id) : "");
  const [a = "", b = ""] = record.subjectIds;
  const period = windowDays === 1 ? "in the last day" : `in the last ${count(windowDays)} days`;
  const copy = COPY[record.kind]({ r: record, m, name, a, b, period, route, labels });
  const claimSegments: ClaimSegment[] = copy.parts.map((part) =>
    typeof part === "string"
      ? { kind: "text", text: part }
      : { kind: "subject", text: name(part.chip), chipId: part.chip },
  );
  const chips: SubjectChip[] = record.subjectIds.map((id) => ({
    id,
    label: name(id),
    entryKind: record.entryKind,
  }));
  const low = m.low;
  const high = m.high;
  return {
    subject: {
      kind: record.subjectKind,
      key: record.subjectKey,
      label: subjectLabel(record, name, labels),
      chips,
    },
    claim: claimSegments.map((s) => s.text).join(""),
    claimSegments,
    figure: copy.figure,
    cost: copy.cost,
    fix: copy.fix,
    fixRoute: route,
    caveat: copy.caveat ?? (mostlyInferred(record.turnSourceMix) ? INFERRED_CAVEAT : null),
    interval: typeof low === "number" && typeof high === "number" ? { low, high } : null,
    chart: chartOf(record),
  };
}

function subjectLabel(
  record: SignalRecord,
  name: (id: string | undefined) => string,
  labels: WorkflowLabels | undefined,
): string {
  const [a, b] = record.subjectIds;
  switch (record.subjectKind) {
    case "tool":
    case "skill":
      return name(a);
    case "tool_pair":
      if (record.kind === "tool_switch") return `${name(a)} to ${name(b)}`;
      return record.kind === "sequence_chain"
        ? `${name(a)} then ${name(b)}`
        : `${name(a)} and ${name(b)}`;
    case "query_cluster":
      return "One repeated ask";
    case "project":
      return record.kind === "dead_tool"
        ? plural(num(record.metrics, "dead"), "tool", "tools")
        : "Whole project";
    case "source":
      return "One source";
    case "workflow":
      return workflowDisplayName(
        { id: record.subjectKey, typicalOrder: record.subjectIds },
        name,
        labels,
      );
  }
}

function chartOf(record: SignalRecord): EvidenceChart | null {
  const bands = record.metrics.rankBands;
  if (record.kind !== "buried_tool" || !Array.isArray(bands) || bands.length !== 4) return null;
  const labels = ["#1-3", "#4-6", "#7-10", "#11+"];
  return {
    kind: "rank_histogram",
    bands: labels.map((label, i) => ({
      label,
      count: typeof bands[i] === "number" ? (bands[i] as number) : 0,
    })),
  };
}
