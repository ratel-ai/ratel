import { z } from "zod";
import { notFound } from "@/lib/mcp/errors";
import {
  callerAccess,
  defaultMonitoringDeps,
  type MonitoringDeps,
  monitoringCaller,
  observeChange,
  refusal,
  required,
} from "@/lib/mcp/operations/monitoring/deps";
import { countOf } from "@/lib/mcp/operations/monitoring/results";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { capRows, limitParam, round, TruncationTracker } from "@/lib/mcp/serialize";
import { formatPercent } from "@/lib/synthesis/traces/v2/format";
import { dashboardsHref } from "@/lib/views/dashboards/links";
import { changeScorer } from "@/lib/views/scorers/actions";
import { CRITERIA_PRESET, parseScorerDraft } from "@/lib/views/scorers/config";
import {
  definitionSummary,
  formatAverage,
  hasVerdict,
  SKIP_LABELS,
  scoreLabel,
} from "@/lib/views/scorers/format";
import { scorerHref, traceHref } from "@/lib/views/scorers/paths";
import { type ScorerUsage, scorerUsage } from "@/lib/views/scorers/picker";
import {
  attachScorer,
  countScorers,
  createScorer,
  deleteScorer,
  detachScorer,
  getScorer,
  latestScores,
  listScorers,
  type ScorerSummary,
  scorerSummaries,
  scorerTrend,
  setScorerEnabled,
} from "@/lib/views/scorers/store";
import { updateScorerWithTask } from "@/lib/views/scorers/task-presets";
import {
  CHECK_OPERATORS,
  JUDGE_OUTPUTS,
  PRESET_KINDS,
  SCORER_KINDS,
  type Scorer,
} from "@/lib/views/scorers/types";

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const TREND_DAYS = 14;

const scorerIdParam = uuidParam().describe("A scorer id from list_scorers.");

/** The scorer form. The action's own parser decides; this says what it reads. */
const draftShape = {
  name: z.string().max(100),
  kind: z.enum(SCORER_KINDS),
  config: z
    .union([
      z.strictObject({
        path: z
          .string()
          .max(200)
          .describe(
            'duration_ms, cost_usd, input_tokens, output_tokens, total_tokens, error, models, tools, agents, mcp_servers, service, environment, or "attributes.<key>" of the root span.',
          ),
        op: z.enum(CHECK_OPERATORS),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .optional()
          .describe("Absent for exists only."),
      }),
      z.strictObject({
        prompt: z
          .string()
          .max(5_000)
          .describe("A closed question on the trace's input and output."),
        output: z.enum(JUDGE_OUTPUTS).describe("boolean: pass or fail. numeric: 1 to 5."),
      }),
      z.strictObject({
        preset: z
          .enum([...PRESET_KINDS, CRITERIA_PRESET])
          .describe(
            "A task kind, graded on the task run of each trace. judge_criteria is saved as a pass-or-fail judge.",
          ),
        max: z
          .number()
          .optional()
          .describe(
            "For max_*: the limit (ms, USD, or a whole number of tool calls or self-corrections).",
          ),
        tool: z.string().max(500).optional().describe("For expected_tool: the tool id."),
        criteria: z.string().max(5_000).optional().describe("For judge_criteria: what to check."),
      }),
    ])
    .describe(
      "A check's path, op and value; a judge's prompt and output; or a preset with its setting (kind preset, with tasks).",
    ),
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Which traces: models, tools, services, environments, agents, mcpServers (lists), status (failed or ok), minCostUsd, minTokens.",
    ),
  tasks: z
    .array(z.string())
    .max(50)
    .nullable()
    .optional()
    .describe("Task ids from list_tasks. Null: every trace."),
  sampleRate: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Percent of the matching traces."),
  enabled: z.boolean().optional(),
};
const scorerDraft = z.strictObject(draftShape);
const EXAMPLE =
  'Example: {"name":"Fast","kind":"check","config":{"path":"duration_ms","op":"lte","value":2000}}, or {"name":"Run time","kind":"preset","config":{"preset":"max_latency_ms","max":2000},"tasks":["<task id>"]}.';

export function scorerReadOperations(deps: MonitoringDeps = defaultMonitoringDeps): McpOperation[] {
  return [
    defineOperation({
      id: "list_scorers",
      domain: "improvement",
      title: "List scorers",
      description:
        "The project's own scorers: each gives every matching trace one stored result. Per scorer: what it checks, which traces it takes, whether it is on, its pass rate or average of the last 7 days, and where it is used (dashboard widgets, alert rules, tasks). A task's fix scorers are in get_task. Change one with change_scorer.",
      keywords: ["scorers", "trace scores", "online evaluation", "llm judge"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, limit: limitParam }),
      async execute(ctx, params) {
        const { projectId } = ctx;
        const [scorers, week, usage] = await Promise.all([
          listScorers(projectId, deps.db()),
          scorerSummaries(projectId, daysAgo(deps, WEEK_DAYS), deps.db()),
          scorerUsage(projectId, deps.db()),
        ]);
        const tracker = new TruncationTracker();
        return {
          data: {
            summary: countOf(
              scorers.length,
              "scorer",
              scorers.map((scorer) => said(scorer, week.get(scorer.id))),
            ),
            count: scorers.length,
            scorers: tracker
              .take(capRows(scorers, params.limit))
              .map((scorer) => listed(scorer, week.get(scorer.id), usage.get(scorer.id), tracker)),
            href: dashboardsHref(projectId),
          },
          truncated: tracker.value,
          hint:
            scorers.length === 0
              ? "No scorer yet. test_scorer tries one on recent traces; change_scorer creates it."
              : "get_scorer shows one scorer's settings, its 14 days and its latest results.",
        };
      },
    }),
    defineOperation({
      id: "get_scorer",
      domain: "improvement",
      title: "Get a scorer",
      description:
        "One scorer: its settings, its results of the last 7 days, 14 days day by day, and its latest results with their traces. Find scorer ids with list_scorers.",
      keywords: ["scorer results", "pass rate over time", "scorer settings"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, scorerId: scorerIdParam, limit: limitParam }),
      async execute(ctx, params) {
        const { projectId } = ctx;
        const db = deps.db();
        const scorer = await getScorer(projectId, params.scorerId, db);
        if (!scorer) throw notFound("scorer");
        const [trend, week, latest, usage] = await Promise.all([
          scorerTrend(projectId, scorer.id, trendStart(deps), db),
          scorerSummaries(projectId, daysAgo(deps, WEEK_DAYS), db),
          latestScores(projectId, scorer.id, params.limit + 1, db),
          scorerUsage(projectId, db),
        ]);
        const tracker = new TruncationTracker();
        return {
          data: {
            summary: `${said(scorer, week.get(scorer.id))}.`,
            scorer: {
              ...listed(scorer, week.get(scorer.id), usage.get(scorer.id), tracker),
              config: scorer.config,
              filter: scorer.filter,
              createdAt: scorer.createdAt.toISOString(),
              updatedAt: scorer.updatedAt.toISOString(),
            },
            trend: trend.map(({ day, ...summary }) => ({ day, ...rates(summary) })),
            latest: tracker.take(capRows(latest, params.limit)).map((row) => ({
              traceId: row.traceId,
              traceStartedAt: row.traceStartedAt.toISOString(),
              scoredAt: row.scoredAt.toISOString(),
              result: scoreLabel(row),
              value: row.value,
              passed: row.passed,
              confidence: round(row.confidence),
              href: traceHref(projectId, row.traceId),
            })),
          },
          truncated: tracker.value,
          hint: "get_trace shows one scored trace; change_scorer changes the scorer.",
        };
      },
    }),
  ];
}

export function scorerWriteOperations(
  deps: MonitoringDeps = defaultMonitoringDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "test_scorer",
      domain: "writes",
      title: "Test a scorer",
      description:
        "Run a scorer, a saved one or a draft, on the 5 newest matching traces, and count the matching traces of the last 7 days. It stores no result. A judge calls a model and spends from the daily budget. Save the draft with change_scorer.",
      keywords: ["test scorer", "preview scorer", "try a judge"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        scorerId: scorerIdParam.optional(),
        scorer: scorerDraft.optional().describe(`A draft, instead of scorerId. ${EXAMPLE}`),
      }),
      async execute(ctx, params) {
        const { projectId } = ctx;
        const stored = params.scorerId
          ? await getScorer(projectId, params.scorerId, deps.db())
          : null;
        if (params.scorerId && !stored) throw notFound("scorer");
        const parsed = parseScorerDraft(
          stored
            ? { ...draftOf(stored), ...params.scorer }
            : withDefaults(required(params.scorer, "scorerId or scorer", "test a scorer")),
        );
        if (!parsed.ok) throw refusal(parsed.error);
        const [results, matching] = await Promise.all([
          deps.previewScorer(projectId, parsed.draft),
          deps.countLastWeek(projectId, parsed.draft),
        ]);
        return {
          data: {
            summary: definitionSummary(parsed.draft),
            matchingTracesLast7Days: matching,
            results: results.map(({ traceId, startedAt, outcome }) => ({
              traceId,
              startedAt,
              href: traceHref(projectId, traceId),
              ...(outcome.status === "scored"
                ? {
                    status: outcome.status,
                    result: scoreLabel(outcome.score),
                    ...outcome.score,
                  }
                : { status: outcome.status, reason: SKIP_LABELS[outcome.reason] }),
            })),
          },
          hint:
            results.length === 0
              ? "No trace matches the filter. Loosen the filter or the tasks."
              : "change_scorer saves it. It then scores the traces that arrive from now on.",
        };
      },
    }),
    defineOperation({
      id: "change_scorer",
      domain: "writes",
      title: "Change a scorer",
      description:
        "Create, update, enable, disable or delete a scorer, or attach it to a task or detach it. A task preset (kind preset) grades the task run of each trace of its tasks. An update changes only the fields it gives. Delete removes every stored result. Try a draft with test_scorer first; read scorers with list_scorers.",
      keywords: ["create scorer", "edit scorer", "attach scorer to task"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        action: z.enum(["create", "update", "enable", "disable", "delete", "attach", "detach"]),
        scorerId: scorerIdParam.optional().describe("Every action but create."),
        scorer: scorerDraft
          .partial()
          .optional()
          .describe(`For create (name, kind and config at least) and update. ${EXAMPLE}`),
        taskId: z.string().max(500).optional().describe("For attach and detach: from list_tasks."),
        narrow: z
          .boolean()
          .optional()
          .describe(
            "For attach: agree that a scorer of every trace becomes one of this task only.",
          ),
      }),
      async execute(ctx, params) {
        const caller = monitoringCaller(ctx);
        const db = deps.db();
        const { projectId } = caller;
        const result = await changeScorer(
          { projectId, ...(await changeOf(params, projectId, deps)) },
          {
            ...callerAccess(ctx, caller),
            get: (project, id) => getScorer(project, id, db),
            count: (project) => countScorers(project, db),
            create: (project, draft, actor) => createScorer(project, draft, actor, db),
            update: (project, id, draft, actor) =>
              updateScorerWithTask(project, id, draft, actor, db),
            setEnabled: (project, id, enabled, actor) =>
              setScorerEnabled(project, id, enabled, actor, db),
            attach: (project, id, task, actor) => attachScorer(project, id, task, actor, db),
            detach: (project, id, task, actor) => detachScorer(project, id, task, actor, db),
            remove: (project, id) => deleteScorer(project, id, db),
            observe: observeChange(deps, ctx, "feature.scorers.changed"),
          },
        );
        if (!result.ok)
          throw refusal(
            result.error.endsWith("Confirm the change first.")
              ? `${result.error.replace(" Confirm the change first.", "")} Pass narrow: true to score only this task. Confirm the change first.`
              : result.error,
          );
        const saved =
          params.action === "delete" ? null : await getScorer(projectId, result.scorerId, db);
        return {
          data: {
            action: params.action,
            scorerId: result.scorerId,
            ...(saved ? { scorer: { ...draftOf(saved), id: saved.id } } : {}),
            href: saved ? scorerHref(projectId, saved.id) : dashboardsHref(projectId),
          },
          hint: saved
            ? "It scores traces about a minute after they end. get_scorer shows the results."
            : "The scorer and its results are gone.",
        };
      },
    }),
  ];
}

type ChangeParams = {
  action: "create" | "update" | "enable" | "disable" | "delete" | "attach" | "detach";
  scorerId?: string;
  scorer?: Record<string, unknown>;
  taskId?: string;
  narrow?: boolean;
};

/** The tool's params as the console's own change. */
async function changeOf(params: ChangeParams, projectId: string, deps: MonitoringDeps) {
  const { action } = params;
  if (action === "create")
    return { action, draft: withDefaults(required(params.scorer, "scorer", action)) };
  const scorerId = required(params.scorerId, "scorerId", action);
  switch (action) {
    case "update": {
      const given = required(params.scorer, "scorer", action);
      const current = await getScorer(projectId, scorerId, deps.db());
      if (!current) throw notFound("scorer");
      return { action, scorerId, draft: { ...draftOf(current), ...given } };
    }
    case "enable":
    case "disable":
      return { action: "set_enabled", scorerId, enabled: action === "enable" };
    case "attach":
    case "detach":
      return {
        action,
        scorerId,
        taskId: required(params.taskId, "taskId", action),
        narrow: params.narrow === true,
      };
    case "delete":
      return { action, scorerId };
  }
}

/** What the form starts with. */
function withDefaults(draft: Record<string, unknown>): Record<string, unknown> {
  return { filter: {}, tasks: null, sampleRate: 100, enabled: true, ...draft };
}

function draftOf({ id: _, projectId: __, createdAt, updatedAt, ...draft }: Scorer) {
  return draft;
}

function listed(
  scorer: Scorer,
  week: ScorerSummary | undefined,
  used: Omit<ScorerUsage, "total"> | undefined,
  tracker: TruncationTracker,
) {
  const { widgets = 0, alerts = 0, tasks = 0 } = used ?? {};
  const total = widgets + alerts + tasks;
  return {
    id: scorer.id,
    name: scorer.name,
    kind: scorer.kind,
    summary: tracker.text(definitionSummary(scorer), 400),
    answers: hasVerdict(scorer) ? "pass_or_fail" : "1_to_5",
    traces:
      scorer.tasks === null
        ? "Every trace"
        : `${scorer.tasks.length} ${scorer.tasks.length === 1 ? "task" : "tasks"}`,
    tasks: scorer.tasks,
    sampleRate: scorer.sampleRate,
    enabled: scorer.enabled,
    status: scorer.enabled ? "on" : "off",
    last7Days: week ? rates(week) : null,
    result: resultText(scorer, week),
    usage: {
      widgets,
      alerts,
      tasks,
      total,
      said: `used in ${total} ${total === 1 ? "place" : "places"}`,
    },
    href: scorerHref(scorer.projectId, scorer.id),
  };
}

/** "Fast (check, on): 95% passed of 120 results in 7 days" */
function said(scorer: Scorer, week: ScorerSummary | undefined): string {
  const result = resultText(scorer, week);
  return `${scorer.name} (${scorer.kind}, ${scorer.enabled ? "on" : "off"}): ${result ? `${result} in 7 days` : "no result in 7 days"}`;
}

function resultText(scorer: Scorer, week: ScorerSummary | undefined): string | null {
  if (!week || week.scored === 0) return null;
  const answer = hasVerdict(scorer)
    ? `${week.passRate === null ? "–" : formatPercent(week.passRate)} passed`
    : `${week.average === null ? "–" : formatAverage(week.average)} of 5`;
  return `${answer}, ${week.scored} ${week.scored === 1 ? "result" : "results"}`;
}

function rates({ scored, passRate, average }: ScorerSummary) {
  return { scored, passRate: round(passRate), average: round(average) };
}

function daysAgo(deps: MonitoringDeps, days: number): Date {
  return new Date(deps.now().getTime() - days * DAY_MS);
}

function trendStart(deps: MonitoringDeps): Date {
  return new Date(
    `${daysAgo(deps, TREND_DAYS - 1)
      .toISOString()
      .slice(0, 10)}T00:00:00Z`,
  );
}
