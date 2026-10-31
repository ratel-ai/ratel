import type {
  ClaimSegment,
  EvidenceChart,
  EvidenceTurn,
  FlowEdge,
  FlowModel,
  FlowNode,
  HealthPageModel,
  HealthTile,
  SignalView,
  StoryQuery,
  TilePoint,
  TurnShapeKind,
  TurnShapeView,
  TurnStoryStep,
} from "@/lib/readings/trace-signals/view";
import { FIRST_READING_FLOOR } from "@/lib/readings/trace-signals/view";

/**
 * A hand-written Agent health model, a demo shaped like a task-tracker agent.
 *
 * It exists so the UI lanes can build the page before the engine lands, and so
 * the page has something honest to render in development. It reproduces the
 * problems we already know a ~93-tool task/project/document catalog has: lists
 * padded to ten, `unlink_pr_from_task` and `delete_task_relationship` picked
 * interchangeably, a write op (`create_task`) riding into task searches, find
 * then assign chains, 209 of 232 asks standing alone, dead tools, one error loop
 * and one slow tool. Shaped like the customer, not copied from it: no end-user
 * query or catalog text from production is baked in here.
 *
 * The numbers are plausible and internally consistent (shapes sum to the turn
 * count, figures to their raw counts), not measured.
 *
 * Never rendered in production: the page only reads it under
 * `NODE_ENV=development` or in tests.
 */

const DAYS = [
  "2026-09-22",
  "2026-09-23",
  "2026-09-24",
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
  "2026-09-28",
] as const;

function series(values: readonly (number | null)[]): readonly TilePoint[] {
  return DAYS.map((day, index) => ({ day, value: values[index] ?? null }));
}

const captured = (text: string): StoryQuery => ({ state: "captured", text });
const NOT_CAPTURED: StoryQuery = { state: "not_captured" };
const EXPIRED: StoryQuery = { state: "expired" };

function searched(query: StoryQuery, listed = 10, flag?: string): TurnStoryStep {
  return { kind: "search", query, listed, ...(flag ? { flag: { label: flag } } : {}) };
}

function ran(
  toolId: string,
  pickedRank: number | null,
  outcome: "ok" | "error" | "unknown" = "ok",
  tookMs: number | null = null,
  flag?: string,
): TurnStoryStep {
  return {
    kind: "invoke",
    toolId,
    pickedRank,
    outcome,
    tookMs,
    ...(flag ? { flag: { label: flag } } : {}),
  };
}

function turn(
  turnId: string,
  startedAt: string,
  steps: readonly TurnStoryStep[],
  turnSource: EvidenceTurn["turnSource"] = "inferred",
): EvidenceTurn {
  return { turnId, traceId: `trace-${turnId}`, startedAt, turnSource, steps };
}

type ClaimPart = string | { chip: string };

/** Builds `claim` and `claimSegments` from one list so the two never disagree. */
function claimOf(parts: readonly ClaimPart[]): {
  claim: string;
  claimSegments: readonly ClaimSegment[];
} {
  const claimSegments: ClaimSegment[] = parts.map((part) =>
    typeof part === "string"
      ? { kind: "text", text: part }
      : { kind: "subject", text: part.chip, chipId: part.chip },
  );
  return { claim: claimSegments.map((segment) => segment.text).join(""), claimSegments };
}

const tool = (id: string) => ({ id, label: id, entryKind: "tool" as const });

const MIX_1284 = { declared: 0, inferred: 1_284, otlp: 0 };

type SignalInput = Omit<
  SignalView,
  "claim" | "claimSegments" | "status" | "tier" | "turnSourceMix" | "firstSeenAt" | "lastSeenAt"
> & {
  parts: readonly ClaimPart[];
  firstSeenAt?: string;
};

function signal({ parts, firstSeenAt, ...rest }: SignalInput): SignalView {
  return {
    ...claimOf(parts),
    status: "open",
    tier: "deterministic",
    turnSourceMix: MIX_1284,
    firstSeenAt: firstSeenAt ?? "2026-09-08T04:00:00.000Z",
    lastSeenAt: "2026-09-28T04:00:00.000Z",
    ...rest,
  };
}

function ranks(bands: readonly [string, number][]): EvidenceChart {
  return { kind: "rank_histogram", bands: bands.map(([label, count]) => ({ label, count })) };
}

/* - Signals, worst first ---------------------------------------------------- */

const SIGNALS: readonly SignalView[] = [
  signal({
    id: "sig-magnet-create-task",
    kind: "magnet",
    subject: {
      kind: "tool",
      key: "create_task",
      label: "create_task",
      chips: [tool("create_task")],
    },
    parts: [{ chip: "create_task" }, " rides into 41% of lists and is picked in 1%."],
    figure: { value: 0.41, unit: "share", display: "41%", raw: "509 lists · 3 picks" },
    severity: 0.97,
    impact: 402,
    cost: "Took a top-3 slot in 402 searches that were looking for an existing task.",
    n: 509,
    interval: { low: 0.383, high: 0.438 },
    fix: "Narrow create_task's description to making new tasks, so it stops matching searches for existing ones.",
    fixRoute: "rewrite_description",
    caveat: null,
    evidence: {
      chart: ranks([
        ["#1", 61],
        ["#2", 158],
        ["#3", 183],
        ["#4-5", 71],
        ["#6-10", 36],
      ]),
      totalTurns: 509,
      turns: [
        turn("t-1001", "2026-09-27T09:14:02.000Z", [
          searched(
            captured("find the onboarding tasks for Acme"),
            10,
            "create_task at #2 · not needed here",
          ),
          ran("search_tasks", 3, "ok", 420),
        ]),
        turn("t-1002", "2026-09-27T11:40:51.000Z", [
          searched(
            captured("which tasks are still open on the billing project"),
            10,
            "create_task at #1 · not needed here",
          ),
          ran("filter_tasks", 4, "ok", 510),
        ]),
        turn("t-1003", "2026-09-26T15:02:19.000Z", [
          searched(NOT_CAPTURED, 10, "create_task at #3 · not needed here"),
          ran("find_task", 5, "ok", 380),
        ]),
        turn("t-1004", "2026-09-25T08:21:44.000Z", [
          searched(
            captured("show me the task about the login redirect"),
            10,
            "create_task at #2 · not needed here",
          ),
          ran("search_tasks", 1, "ok", 402),
        ]),
      ],
    },
  }),
  signal({
    id: "sig-padding-project",
    kind: "padding_share",
    subject: { kind: "project", key: "project", label: "Search lists", chips: [] },
    parts: ["Lists are filled to 10; picks below #5 are 2%."],
    figure: { value: 0.58, unit: "share", display: "58%", raw: "7,190 of 12,410 hits" },
    severity: 0.9,
    impact: 7_190,
    cost: "About 7,190 hits the agent read and never needed this window.",
    n: 12_410,
    interval: { low: 0.571, high: 0.589 },
    fix: "Return 5 results per search instead of 10. The agent almost never picks below #5, and the extra hits cost tokens on every turn.",
    fixRoute: "lower_top_k",
    caveat:
      "Junk is estimated from score gaps, not judged. The classifier tier will replace this estimate.",
    evidence: {
      chart: ranks([
        ["#1", 604],
        ["#2", 231],
        ["#3", 118],
        ["#4-5", 44],
        ["#6-10", 21],
      ]),
      totalTurns: 1_241,
      turns: [
        turn("t-1101", "2026-09-28T07:55:10.000Z", [
          searched(captured("assign ACME-88 to Mia"), 10, "10 listed, picked #1"),
          ran("assign_task", 1, "ok", 290),
        ]),
        turn("t-1102", "2026-09-27T13:31:08.000Z", [
          searched(captured("what changed on the roadmap doc"), 10, "10 listed, picked #2"),
          ran("entity_lookup", 2, "ok", 1_240),
        ]),
        turn("t-1103", "2026-09-26T17:12:36.000Z", [
          searched(EXPIRED, 10, "10 listed, picked #1"),
          ran("search_tasks", 1, "ok", 388),
        ]),
      ],
    },
  }),
  signal({
    id: "sig-siblings-unlink-delete",
    kind: "sibling_confusion",
    subject: {
      kind: "tool_pair",
      key: "delete_task_relationship|unlink_pr_from_task",
      label: "unlink_pr_from_task and delete_task_relationship",
      chips: [tool("unlink_pr_from_task"), tool("delete_task_relationship")],
    },
    parts: [
      { chip: "unlink_pr_from_task" },
      " and ",
      { chip: "delete_task_relationship" },
      " are shown together and picked at random.",
    ],
    figure: { value: 14, unit: "count", display: "14", raw: "swaps in 33 turns" },
    severity: 0.81,
    impact: 14,
    cost: "14 turns ran the wrong one of the two first.",
    n: 33,
    interval: { low: 0.28, high: 0.59 },
    fix: "Rewrite both descriptions to say which link each removes: pull requests for unlink_pr_from_task, links between tasks for delete_task_relationship.",
    fixRoute: "disambiguate_pair",
    caveat:
      "Which of the two was right is not counted here. The swaps only show the agent could not tell them apart.",
    evidence: {
      chart: null,
      totalTurns: 33,
      turns: [
        turn("t-1201", "2026-09-27T10:05:40.000Z", [
          searched(captured("unlink PR 412 from ACME-88")),
          ran("delete_task_relationship", 1, "error", 210, "Picked the sibling"),
          ran("unlink_pr_from_task", 2, "ok", 260),
        ]),
        turn("t-1202", "2026-09-25T16:48:03.000Z", [
          searched(captured("remove the blocker link between ACME-90 and ACME-91")),
          ran("unlink_pr_from_task", 1, "error", 190, "Picked the sibling"),
          ran("delete_task_relationship", 2, "ok", 240),
        ]),
        turn("t-1203", "2026-09-24T12:20:17.000Z", [
          searched(NOT_CAPTURED),
          ran("delete_task_relationship", 2, "ok", 230, "Picked #2 over its sibling at #1"),
        ]),
      ],
    },
  }),
  signal({
    id: "sig-chain-find-assign",
    kind: "sequence_chain",
    subject: {
      kind: "tool_pair",
      key: "find_task>assign_task",
      label: "find_task then assign_task",
      chips: [tool("find_task"), tool("assign_task")],
    },
    parts: [{ chip: "find_task" }, " precedes ", { chip: "assign_task" }, " in 78% of assigns."],
    figure: { value: 0.78, unit: "share", display: "78%", raw: "46 of 59 assigns" },
    severity: 0.74,
    impact: 75,
    cost: "29 of these chains needed a second search to find assign_task.",
    n: 59,
    interval: { low: 0.66, high: 0.87 },
    fix: "Write a skill that finds and assigns in one step.",
    fixRoute: "workflow_skill",
    caveat: null,
    evidence: {
      chart: null,
      totalTurns: 46,
      turns: [
        turn("t-1301", "2026-09-28T08:30:12.000Z", [
          searched(captured("assign the billing bug to Dana")),
          ran("find_task", 1, "ok", 350),
          searched(captured("assign task"), 10, "A second search to reach the next tool"),
          ran("assign_task", 4, "ok", 300),
        ]),
        turn("t-1302", "2026-09-26T14:10:55.000Z", [
          searched(captured("give the SSO task to Omar")),
          ran("find_task", 2, "ok", 330),
          ran("assign_task", 3, "ok", 280),
        ]),
        turn("t-1303", "2026-09-24T09:44:31.000Z", [
          searched(captured("hand ACME-77 over to whoever owns payments")),
          ran("find_task", 1, "ok", 360),
          searched(NOT_CAPTURED, 10, "A second search to reach the next tool"),
          ran("assign_task", 6, "ok", 310),
        ]),
      ],
    },
  }),
  signal({
    id: "sig-first-try-assign",
    kind: "first_try_miss",
    subject: {
      kind: "tool",
      key: "assign_task",
      label: "assign_task",
      chips: [tool("assign_task")],
    },
    parts: [
      "The agent had to search again for the same thing before it found ",
      { chip: "assign_task" },
      ".",
    ],
    figure: { value: 0.36, unit: "share", display: "36%", raw: "21 of 59 calls" },
    severity: 0.71,
    impact: 27,
    cost: "27 extra searches this window.",
    n: 59,
    interval: { low: 0.25, high: 0.48 },
    fix: "Rewrite assign_task's description with the words people use to hand work over: assign, give, hand to, owner.",
    fixRoute: "rewrite_description",
    caveat: null,
    evidence: {
      chart: ranks([
        ["#1-3", 38],
        ["#4-10", 9],
        ["not listed", 12],
      ]),
      totalTurns: 21,
      turns: [
        turn("t-1401", "2026-09-27T15:22:09.000Z", [
          searched(captured("give this to Priya"), 10, "assign_task not listed"),
          searched(captured("assign task to user")),
          ran("assign_task", 1, "ok", 270),
        ]),
        turn("t-1402", "2026-09-25T10:03:47.000Z", [
          searched(captured("make Leo the owner of ACME-12"), 10, "assign_task not listed"),
          searched(captured("change task owner")),
          ran("assign_task", 2, "ok", 295),
        ]),
        turn("t-1403", "2026-09-23T13:50:26.000Z", [
          searched(NOT_CAPTURED, 10, "assign_task listed at #9"),
          searched(NOT_CAPTURED),
          ran("assign_task", 1, "ok", 305),
        ]),
      ],
    },
  }),
  signal({
    id: "sig-buried-update-task",
    kind: "buried_tool",
    subject: {
      kind: "tool",
      key: "update_task",
      label: "update_task",
      chips: [tool("update_task")],
    },
    parts: [{ chip: "update_task" }, " is the right tool and sits at #7 when picked."],
    figure: { value: 7, unit: "rank", display: "#7", raw: "41 of 88 picks below #3" },
    severity: 0.66,
    impact: 41,
    cost: "41 turns read six or more hits before reaching it.",
    n: 88,
    interval: { low: 0.37, high: 0.57 },
    fix: "Move update_task up for edit-style asks, then tighten its description.",
    fixRoute: "adaptive_ranking",
    caveat: null,
    evidence: {
      chart: ranks([
        ["#1-3", 47],
        ["#4-6", 12],
        ["#7-10", 29],
      ]),
      totalTurns: 41,
      turns: [
        turn("t-1501", "2026-09-28T06:12:40.000Z", [
          searched(captured("move ACME-40 to in review")),
          ran("update_task", 7, "ok", 330, "Picked from #7"),
        ]),
        turn("t-1502", "2026-09-26T11:37:15.000Z", [
          searched(captured("rename the onboarding task")),
          ran("update_task", 8, "ok", 310, "Picked from #8"),
        ]),
        turn("t-1503", "2026-09-24T18:05:58.000Z", [
          searched(captured("set the due date on ACME-51 to Friday")),
          ran("update_task", 6, "ok", 345, "Picked from #6"),
        ]),
      ],
    },
  }),
  signal({
    id: "sig-fragmented-project",
    kind: "fragmented_intents",
    subject: { kind: "project", key: "project", label: "Asks", chips: [] },
    parts: ["209 of 232 asks stand alone."],
    figure: { value: 0.9, unit: "share", display: "90%", raw: "209 of 232" },
    severity: 0.62,
    impact: 209,
    cost: "Search cannot learn from an ask it has only seen once.",
    n: 232,
    interval: { low: 0.856, high: 0.931 },
    fix: "Group repeated asks so the agent can learn from them. Most of these are one-off phrasings of the same few jobs.",
    fixRoute: "run_extraction",
    caveat: "Read from the stored intent graph, not from this window's turns.",
    evidence: { chart: null, totalTurns: 0, turns: [] },
  }),
  signal({
    id: "sig-dead-tools",
    kind: "dead_tool",
    subject: {
      kind: "project",
      key: "project",
      label: "23 tools",
      chips: [tool("archive_project"), tool("export_task_csv"), tool("bulk_move_tasks")],
    },
    parts: ["23 tools were never listed and never run."],
    figure: { value: 23, unit: "count", display: "23", raw: "of 93 tools" },
    severity: 0.58,
    impact: 23,
    cost: "Each one still costs a slot in every catalog sync.",
    n: 1_284,
    interval: null,
    fix: "Retire them, or merge each into the sibling that does get used.",
    fixRoute: "retire_tool",
    caveat: null,
    evidence: { chart: null, totalTurns: 0, turns: [] },
  }),
  signal({
    id: "sig-error-loop-link-pr",
    kind: "error_loop",
    subject: {
      kind: "tool",
      key: "link_pr_to_task",
      label: "link_pr_to_task",
      chips: [tool("link_pr_to_task")],
    },
    parts: [{ chip: "link_pr_to_task" }, " fails and is retried in the same turn."],
    figure: { value: 17, unit: "count", display: "17", raw: "errors · 5 looping turns" },
    severity: 0.55,
    impact: 22,
    cost: "17 failed calls, 12 of them retries of a call that had just failed.",
    n: 31,
    interval: { low: 0.37, high: 0.71 },
    fix: "Show these turns to whoever owns link_pr_to_task. The retries repeat the same call.",
    fixRoute: "show_turns",
    caveat: null,
    evidence: {
      chart: null,
      totalTurns: 5,
      turns: [
        turn("t-1601", "2026-09-27T14:18:22.000Z", [
          searched(captured("link PR 988 to the auth task")),
          ran("link_pr_to_task", 1, "error", 640, "Fails"),
          ran("link_pr_to_task", 1, "error", 610, "Retried"),
          ran("link_pr_to_task", 1, "error", 655, "Retried"),
        ]),
        turn("t-1602", "2026-09-25T09:27:45.000Z", [
          searched(captured("attach the fix PR to ACME-63")),
          ran("link_pr_to_task", 2, "error", 590, "Fails"),
          ran("link_pr_to_task", 2, "ok", 720),
        ]),
        turn("t-1603", "2026-09-23T16:59:01.000Z", [
          searched(NOT_CAPTURED),
          ran("link_pr_to_task", 1, "error", 600, "Fails"),
          ran("link_pr_to_task", 1, "error", 615, "Retried"),
        ]),
      ],
    },
  }),
  signal({
    id: "sig-unstable-plate",
    kind: "unstable_intent",
    subject: {
      kind: "query_cluster",
      key: "q:7f3a91",
      label: "What is on my plate",
      chips: [
        tool("search_tasks"),
        tool("filter_tasks"),
        tool("find_task"),
        tool("entity_lookup"),
        tool("search_projects"),
      ],
    },
    parts: ["The same ask resolves to 5 different tools."],
    figure: { value: 0.33, unit: "share", display: "33%", raw: "top tool in 4 of 12" },
    severity: 0.49,
    impact: 8,
    cost: "8 turns started on a tool the rest of this ask did not use.",
    n: 12,
    interval: { low: 0.14, high: 0.61 },
    fix: "Pin the tool that worked for this ask, so it comes first next time.",
    fixRoute: "adaptive_ranking",
    caveat: "Grouped by exact query match; near phrasings are not merged yet.",
    evidence: {
      chart: null,
      totalTurns: 12,
      turns: [
        turn("t-1701", "2026-09-28T07:02:11.000Z", [
          searched(captured("what's on my plate today")),
          ran("filter_tasks", 2, "ok", 480),
        ]),
        turn("t-1702", "2026-09-27T07:05:38.000Z", [
          searched(captured("what's on my plate today")),
          ran("search_tasks", 1, "ok", 410),
        ]),
        turn("t-1703", "2026-09-26T07:01:59.000Z", [
          searched(captured("what's on my plate today")),
          ran("entity_lookup", 3, "ok", 1_310),
        ]),
      ],
    },
  }),
  signal({
    id: "sig-latency-entity-lookup",
    kind: "latency_outlier",
    subject: {
      kind: "tool",
      key: "entity_lookup",
      label: "entity_lookup",
      chips: [tool("entity_lookup")],
    },
    parts: [
      { chip: "entity_lookup" },
      " takes 12 s on its slow calls, against 1.4 s for a typical tool.",
    ],
    figure: { value: 12_400, unit: "ms", display: "12 s", raw: "over 142 calls" },
    severity: 0.41,
    impact: 1_562,
    cost: "About 26 minutes of waiting this window.",
    n: 142,
    interval: null,
    fix: "Nothing to change in the catalog. The time is spent inside entity_lookup.",
    fixRoute: "none",
    caveat: null,
    evidence: {
      chart: {
        kind: "sparkline",
        points: series([9_800, 11_200, 12_900, 10_400, 13_600, 12_100, 12_400]),
      },
      totalTurns: 142,
      turns: [
        turn("t-1801", "2026-09-27T12:44:30.000Z", [
          searched(captured("who touched the pricing doc last")),
          ran("entity_lookup", 1, "ok", 14_200, "Took 14.2 s"),
        ]),
        turn("t-1802", "2026-09-25T13:09:12.000Z", [
          searched(captured("find the design review document")),
          ran("entity_lookup", 2, "ok", 12_900, "Took 12.9 s"),
        ]),
        turn("t-1803", "2026-09-23T10:31:48.000Z", [
          searched(EXPIRED),
          ran("entity_lookup", 1, "ok", 12_600, "Took 12.6 s"),
        ]),
      ],
    },
  }),
  signal({
    id: "sig-no-follow-search-projects",
    kind: "no_follow_through",
    subject: {
      kind: "tool",
      key: "search_projects",
      label: "search_projects",
      chips: [tool("search_projects")],
    },
    parts: [
      "After running ",
      { chip: "search_projects" },
      ", the agent searched again for the same thing.",
    ],
    figure: { value: 0.3, unit: "share", display: "30%", raw: "19 of 64 calls" },
    severity: 0.36,
    impact: 19,
    cost: "19 extra searches straight after it answered.",
    n: 64,
    interval: { low: 0.2, high: 0.42 },
    fix: "Rewrite search_projects to say it returns projects, not their tasks. The agent keeps expecting tasks back.",
    fixRoute: "rewrite_description",
    caveat: null,
    evidence: {
      chart: null,
      totalTurns: 19,
      turns: [
        turn("t-1901", "2026-09-28T09:40:02.000Z", [
          searched(captured("tasks in the mobile project")),
          ran("search_projects", 1, "ok", 520, "Ran, then searched again for the same thing"),
          searched(captured("tasks for project mobile")),
          ran("filter_tasks", 1, "ok", 470),
        ]),
        turn("t-1902", "2026-09-26T10:15:27.000Z", [
          searched(captured("open work on the website revamp")),
          ran("search_projects", 2, "ok", 505, "Ran, then searched again for the same thing"),
          searched(NOT_CAPTURED),
          ran("search_tasks", 1, "ok", 430),
        ]),
        turn("t-1903", "2026-09-24T15:33:50.000Z", [
          searched(captured("what's left on Q4 planning")),
          ran("search_projects", 1, "ok", 490, "Ran, then searched again for the same thing"),
          searched(captured("Q4 planning tasks")),
          ran("filter_tasks", 2, "ok", 455),
        ]),
      ],
    },
  }),
];

const TOO_EARLY: readonly SignalView[] = [
  signal({
    id: "sig-repeat-add-comment",
    kind: "repeat_invoke",
    subject: {
      kind: "tool",
      key: "add_task_comment",
      label: "add_task_comment",
      chips: [tool("add_task_comment")],
    },
    parts: [{ chip: "add_task_comment" }, " is called 3 or more times in one turn."],
    figure: { value: 4, unit: "count", display: "4", raw: "of 11 turns" },
    severity: 0.18,
    impact: 9,
    cost: "9 extra calls this window.",
    n: 11,
    interval: { low: 0.15, high: 0.65 },
    fix: "Look at the turns. Telling identical repeats from separate comments needs content capture.",
    fixRoute: "show_turns",
    caveat: "Too few turns to call yet.",
    firstSeenAt: "2026-09-26T04:00:00.000Z",
    evidence: {
      chart: null,
      totalTurns: 4,
      turns: [
        turn("t-2001", "2026-09-27T16:20:14.000Z", [
          searched(captured("comment on ACME-88 that it is fixed")),
          ran("add_task_comment", 1, "ok", 240),
          ran("add_task_comment", 1, "ok", 250, "Called again"),
          ran("add_task_comment", 1, "ok", 235, "And again"),
        ]),
      ],
    },
  }),
  signal({
    id: "sig-first-try-filter",
    kind: "first_try_miss",
    subject: {
      kind: "tool",
      key: "filter_tasks",
      label: "filter_tasks",
      chips: [tool("filter_tasks")],
    },
    parts: [
      "The agent had to search again for the same thing before it found ",
      { chip: "filter_tasks" },
      ".",
    ],
    figure: { value: 0.25, unit: "share", display: "25%", raw: "3 of 12 calls" },
    severity: 0.09,
    impact: 3,
    cost: "3 extra searches this window.",
    n: 12,
    interval: { low: 0.09, high: 0.53 },
    fix: "Wait for more turns before changing anything.",
    fixRoute: "none",
    caveat: "Too few turns to call yet.",
    firstSeenAt: "2026-09-27T04:00:00.000Z",
    evidence: { chart: null, totalTurns: 3, turns: [] },
  }),
];

/* - Band, map, shapes ------------------------------------------------------- */

const TILES: readonly HealthTile[] = [
  {
    key: "first_try",
    label: "First try",
    value: 0.64,
    unit: "share",
    interval: { low: 0.614, high: 0.666 },
    sub: "822 of 1,284 turns found the tool in the first search.",
    tier: "deterministic",
    upIsGood: true,
    delta: 0.03,
    series: series([0.61, 0.6, 0.63, 0.65, 0.64, 0.66, 0.67]),
    n: 1_284,
  },
  {
    key: "detours",
    label: "Detours",
    value: 0.18,
    unit: "share",
    interval: { low: 0.159, high: 0.202 },
    sub: "231 turns searched again for the same thing.",
    tier: "deterministic",
    upIsGood: false,
    delta: -0.02,
    series: series([0.21, 0.2, 0.19, 0.18, 0.17, 0.18, 0.16]),
    n: 1_284,
  },
  {
    key: "junk",
    label: "Junk in lists",
    value: 0.58,
    unit: "share",
    interval: { low: 0.571, high: 0.589 },
    sub: "Hits well below the top score, read and never picked.",
    tier: "deterministic",
    upIsGood: false,
    delta: 0,
    series: series([0.58, 0.59, 0.57, 0.58, 0.58, 0.59, 0.58]),
    n: 12_410,
  },
  {
    key: "wasted_calls",
    label: "Wasted calls",
    value: 9.4,
    unit: "per_100_turns",
    interval: { low: 7.8, high: 11.2 },
    sub: "Repeats, retries after an error, and calls followed by a search for the same thing.",
    tier: "deterministic",
    upIsGood: false,
    delta: 1.1,
    series: series([8.2, 8.9, 9.1, 9.8, 9.6, 10.1, 9.9]),
    n: 1_284,
  },
];

function node(
  id: string,
  invocations: number,
  impressions: number,
  tint: FlowNode["tint"] = "none",
  signalIds: readonly string[] = [],
): FlowNode {
  return { id, kind: "tool", label: id, invocations, impressions, tint, signalIds };
}

function edge(
  from: string,
  to: string,
  kind: FlowEdge["kind"],
  count: number,
  confidence: number,
  tint: FlowEdge["tint"] = "none",
  signalIds: readonly string[] = [],
): FlowEdge {
  return { from, to, kind, count, confidence, tint, signalIds };
}

const FLOW: FlowModel = {
  totalTools: 93,
  nodes: [
    {
      id: "search",
      kind: "search",
      label: "Search",
      invocations: 0,
      impressions: 0,
      tint: "none",
      signalIds: ["sig-padding-project"],
    },
    node("search_tasks", 402, 1_106, "healthy"),
    node("entity_lookup", 142, 410, "none", ["sig-latency-entity-lookup"]),
    node("find_task", 131, 702, "healthy", ["sig-chain-find-assign"]),
    node("filter_tasks", 88, 640),
    node("update_task", 88, 301, "buried", ["sig-buried-update-task"]),
    node("add_task_comment", 77, 290),
    node("search_projects", 64, 233, "none", ["sig-no-follow-search-projects"]),
    node("assign_task", 59, 388, "none", ["sig-first-try-assign", "sig-chain-find-assign"]),
    node("link_pr_to_task", 31, 96, "none", ["sig-error-loop-link-pr"]),
    node("create_task_relationship", 22, 118, "healthy"),
    node("unlink_pr_from_task", 19, 140, "none", ["sig-siblings-unlink-delete"]),
    node("delete_task_relationship", 16, 151, "none", ["sig-siblings-unlink-delete"]),
    node("create_task", 12, 509, "magnet", ["sig-magnet-create-task"]),
    node("archive_project", 0, 0, "dead", ["sig-dead-tools"]),
    node("export_task_csv", 0, 0, "dead", ["sig-dead-tools"]),
    {
      id: "quiet",
      kind: "quiet",
      label: "and 78 quiet tools",
      invocations: 96,
      impressions: 1_412,
      tint: "none",
      signalIds: [],
      quietCount: 78,
    },
  ],
  edges: [
    edge("search", "search_tasks", "pick", 402, 0.95, "healthy"),
    edge("search", "find_task", "pick", 131, 0.9, "healthy"),
    edge("search", "entity_lookup", "pick", 120, 0.88),
    edge("search", "filter_tasks", "pick", 88, 0.84),
    edge("search", "update_task", "pick", 88, 0.84, "buried", ["sig-buried-update-task"]),
    edge("search", "search_projects", "pick", 64, 0.8),
    edge("search", "add_task_comment", "pick", 61, 0.8),
    edge("search", "assign_task", "pick", 38, 0.72),
    edge("search", "link_pr_to_task", "pick", 29, 0.7),
    edge("search", "create_task_relationship", "pick", 22, 0.66, "healthy"),
    edge("search", "unlink_pr_from_task", "pick", 19, 0.62),
    edge("search", "delete_task_relationship", "pick", 16, 0.6),
    edge("search", "create_task", "pick", 3, 0.9, "magnet", ["sig-magnet-create-task"]),
    edge("search", "quiet", "pick", 70, 0.5),
    edge("find_task", "assign_task", "sequence", 46, 0.82, "none", ["sig-chain-find-assign"]),
    edge("search_tasks", "update_task", "sequence", 37, 0.7),
    edge("find_task", "add_task_comment", "sequence", 24, 0.64),
    edge("search_projects", "search_tasks", "sequence", 19, 0.6, "none", [
      "sig-no-follow-search-projects",
    ]),
    edge("create_task", "assign_task", "sequence", 7, 0.4),
    edge("delete_task_relationship", "unlink_pr_from_task", "sibling", 14, 0.7, "buried", [
      "sig-siblings-unlink-delete",
    ]),
  ],
};

const SHAPE_COPY: Record<TurnShapeKind, { label: string; description: string }> = {
  direct: { label: "Direct", description: "Searched once and ran the right tool." },
  detour: { label: "Detour", description: "Searched again for the same thing." },
  dead_end: { label: "Dead end", description: "Searched and ran nothing." },
  retry: { label: "Retry", description: "Ran a tool, it failed, ran it again." },
  blind: { label: "Blind", description: "Ran a tool without searching." },
  repeat: { label: "Repeat", description: "Ran the same tool again in one turn." },
};

function shapes(counts: Readonly<Record<TurnShapeKind, number>>): readonly TurnShapeView[] {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return (Object.keys(counts) as TurnShapeKind[])
    .map((shape) => ({
      shape,
      ...SHAPE_COPY[shape],
      count: counts[shape],
      share: total === 0 ? 0 : counts[shape] / total,
    }))
    .sort((a, b) => b.count - a.count);
}

const CAPTURE_UNLOCKS: HealthPageModel["captureUnlocks"] = [
  {
    key: "cooccurring_intents",
    label: "Intents that travel together",
    description: "Asks that arrive in the same turn, drafted into one skill.",
  },
  {
    key: "detour_clusters",
    label: "Detour clusters",
    description: "The phrasings that send the agent on a second search.",
  },
  {
    key: "identical_repeats",
    label: "Identical repeat calls",
    description: "The same call with the same arguments, told apart from real follow-ups.",
  },
  {
    key: "classifier_junk",
    label: "Junk judged by a classifier",
    description: "Which listed hits could never have answered the ask.",
  },
];

/* - Exports ----------------------------------------------------------------- */

/** The full picture: 1,284 turns, tools-only capture, 12 signals, 2 too early. */
export const MOCK_HEALTH_MODEL: HealthPageModel = {
  windowDays: 7,
  turns: 1_284,
  floor: FIRST_READING_FLOOR,
  captureLevel: "tools",
  turnSourceMix: MIX_1284,
  tiles: TILES,
  flow: FLOW,
  shapes: shapes({ direct: 822, detour: 231, dead_end: 103, retry: 51, blind: 51, repeat: 26 }),
  signals: SIGNALS,
  tooEarly: TOO_EARLY,
  lockedCount: 0,
  evidenceTurnsPerSignal: 5,
  captureUnlocks: CAPTURE_UNLOCKS,
  computedAt: "2026-09-28T04:00:00.000Z",
  signalWindowDays: 7,
  sourceMode: "sdk",
  // The a demo shaped like a task-tracker agent fixture predates workflows: the section is not drawn.
  workflows: null,
};

function emptyTiles(): readonly HealthTile[] {
  return TILES.map((tile) => ({
    ...tile,
    value: null,
    interval: null,
    delta: null,
    sub: "Waiting for enough turns.",
    series: series([]),
    n: 0,
  }));
}

const EMPTY_FLOW: FlowModel = { totalTools: 0, nodes: [], edges: [] };
const NO_SIGNALS: Pick<HealthPageModel, "signals" | "tooEarly" | "lockedCount"> = {
  signals: [],
  tooEarly: [],
  lockedCount: 0,
};

/** Nothing has arrived: the page shows "Send traces to see how your agent is doing". */
export const MOCK_NO_TELEMETRY: HealthPageModel = {
  ...MOCK_HEALTH_MODEL,
  ...NO_SIGNALS,
  turns: 0,
  captureLevel: "events",
  turnSourceMix: { declared: 0, inferred: 0, otlp: 0 },
  tiles: emptyTiles(),
  flow: EMPTY_FLOW,
  shapes: shapes({ direct: 0, detour: 0, dead_end: 0, retry: 0, blind: 0, repeat: 0 }),
  computedAt: null,
  signalWindowDays: null,
};

/** Traces are landing but not enough for a reading: "Collecting · 14 of 50 turns". */
export const MOCK_COLLECTING: HealthPageModel = {
  ...MOCK_NO_TELEMETRY,
  turns: 14,
  captureLevel: "tools",
  turnSourceMix: { declared: 0, inferred: 14, otlp: 0 },
  shapes: shapes({ direct: 9, detour: 2, dead_end: 2, retry: 0, blind: 1, repeat: 0 }),
};

/** A tile read over 72 turns: same figure, a much wider interval, no previous window. */
function thinTile(tile: HealthTile): HealthTile {
  const spread = tile.unit === "share" ? 0.11 : 3.5;
  const value = tile.value ?? 0;
  const floor = tile.unit === "share" ? 1 : Infinity;
  return {
    ...tile,
    interval: { low: Math.max(0, value - spread), high: Math.min(floor, value + spread) },
    delta: null,
    sub: tile.key === "junk" ? "Estimated over 690 listed hits." : "Estimated over 72 turns.",
    n: tile.key === "junk" ? 690 : 72,
  };
}

/** Past the floor with nothing confident yet: everything sits under "Too early to call". */
export const MOCK_THIN_EVIDENCE: HealthPageModel = {
  ...MOCK_HEALTH_MODEL,
  turns: 72,
  turnSourceMix: { declared: 0, inferred: 72, otlp: 0 },
  tiles: TILES.map((tile) => thinTile(tile)),
  shapes: shapes({ direct: 44, detour: 14, dead_end: 7, retry: 3, blind: 3, repeat: 1 }),
  signals: [],
  tooEarly: TOO_EARLY,
  lockedCount: 0,
};
