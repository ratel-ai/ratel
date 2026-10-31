import { type SignalTone, signalTone } from "@/components/console/health/card-model";
import {
  groupByKind,
  groupFigure,
  groupFixLead,
  groupTitle,
  groupTone,
  memberLabel,
  type ProblemGroup,
  primaryOf,
} from "@/components/console/health/problem-groups";
import { formatWorkflowTime } from "@/components/console/health/workflow-copy";
import {
  WORKFLOW_STATUS_LABEL,
  type WorkflowStatus,
  workflowStatus,
} from "@/components/console/health/workflow-row-model";
import { clampFigures, formatCount } from "@/lib/readings/trace-signals/claims";
import {
  type HealthPageModel,
  type HealthTile,
  healthReadiness,
  runWindowLabel,
  type TilePoint,
} from "@/lib/readings/trace-signals/view";
import { productWords } from "@/lib/views/fixes/copy";
import { sourceBadgeText } from "@/lib/views/health/source-mode";
import { type DeltaTone, sparkDomain, tileDelta, tileFigure } from "@/lib/views/health/tiles";
import { chainFolding } from "@/lib/views/health/workflows-view";

/**
 * The Agent health report, decided here and only laid out by
 * `HealthReportDocument`. It reads the redacted model (`publicHealthModel`)
 * whoever prints it, because a PDF travels further than the page it came from.
 */

export interface ReportReading {
  key: string;
  label: string;
  value: string;
  unit: string | null;
  delta: { text: string; tone: DeltaTone } | null;
  sub: string;
  /** SVG path in a 100 x 26 box; null with fewer than two measured days. */
  path: string | null;
}

export interface ReportProblem {
  key: string;
  tone: Exclude<SignalTone, "muted">;
  title: string;
  tools: string | null;
  claim: string;
  figure: string;
  caption: string;
  cost: string;
  fix: string;
}

export interface ReportWorkflow {
  id: string;
  name: string;
  steps: string;
  runs: string;
  finish: string;
  time: string | null;
  status: WorkflowStatus;
  statusLabel: string;
}

export interface HealthReport {
  projectName: string;
  organizationName: string | null;
  windowLabel: string;
  generatedOn: string;
  runs: string;
  source: string | null;
  ready: boolean;
  /** One or two sentences under the title: the reading in words. */
  verdict: string;
  readings: readonly ReportReading[];
  shapes: readonly {
    key: string;
    label: string;
    description: string;
    share: string;
    width: number;
    count: string;
  }[];
  problems: readonly ReportProblem[];
  /** The span problems were read over when it differs from the window ("last 22 days"). */
  problemsSpan: string | null;
  hiddenProblems: number;
  workflows: readonly ReportWorkflow[];
}

const WIDTH = 100;
const HEIGHT = 26;
const MAX_TOOL_NAMES = 4;

/** A sparkline path through the measured days, gaps skipped. */
export function sparkPath(series: readonly TilePoint[], unit: HealthTile["unit"]): string | null {
  const domain = sparkDomain(series, unit);
  const measured = series.flatMap((point, index) =>
    point.value === null ? [] : [{ index, value: point.value }],
  );
  if (!domain || measured.length < 2 || series.length < 2) return null;
  const span = domain.max - domain.min || 1;
  const x = (index: number) => (index / (series.length - 1)) * WIDTH;
  const y = (value: number) => HEIGHT - 2 - ((value - domain.min) / span) * (HEIGHT - 4);
  return measured
    .map(
      (point, i) =>
        `${i === 0 ? "M" : "L"}${x(point.index).toFixed(1)} ${y(point.value).toFixed(1)}`,
    )
    .join(" ");
}

function reading(tile: HealthTile): ReportReading {
  const figure = tileFigure(tile);
  const delta = tileDelta(tile);
  return {
    key: tile.key,
    label: tile.label,
    value: figure.value,
    unit: figure.unit,
    delta: delta && delta.direction !== "flat" ? { text: delta.text, tone: delta.tone } : null,
    sub: tile.sub,
    path: figure.ready ? sparkPath(tile.series, tile.unit) : null,
  };
}

function toolNames(group: ProblemGroup): string | null {
  // Only members that name tools: a project-level signal's label ("Whole project") is not a tool.
  const names = group.members
    .filter((member) => member.subject.chips.length > 0)
    .map(memberLabel)
    .filter((name) => name.length > 0);
  if (names.length === 0 || group.kind.startsWith("workflow_")) return null;
  const shown = names.slice(0, MAX_TOOL_NAMES).join(", ");
  return names.length > MAX_TOOL_NAMES
    ? `${shown} and ${names.length - MAX_TOOL_NAMES} more`
    : shown;
}

function problem(group: ProblemGroup): ReportProblem {
  const lead = primaryOf(group);
  const figure = groupFigure(group);
  const tone = groupTone(group);
  // The engine's sentences, in the product's nouns (an issue, a task), as on the Summary.
  return {
    key: `${group.kind}:${lead.id}`,
    tone: tone === "coral" ? "coral" : "amber",
    title: productWords(groupTitle(group)),
    tools: toolNames(group),
    claim: productWords(clampFigures(lead.claim)),
    figure: figure.display,
    caption: figure.caption,
    cost: productWords(clampFigures(lead.cost)),
    fix: productWords(groupFixLead(group)),
  };
}

function verdictOf(model: HealthPageModel, groups: readonly ProblemGroup[]): string {
  if (healthReadiness(model) !== "ready") {
    return `No reading yet: ${formatCount(model.turns)} of the ${formatCount(model.floor)} runs a first reading needs have arrived.`;
  }
  if (groups.length === 0)
    return "No issues in this window. The agent is finding and running its tools cleanly.";
  const urgent = groups.filter(
    (group) => signalTone(primaryOf(group).severity, false) === "coral",
  ).length;
  const head = `${groups.length} ${groups.length === 1 ? "issue" : "issues"}${urgent > 0 ? `, ${urgent} to fix now` : ""}.`;
  const top = groups[0]!;
  const names = toolNames(top);
  return `${head} The most pressing: ${productWords(groupTitle(top)).toLowerCase()}${names ? ` (${names})` : ""}.`;
}

export function buildHealthReport(
  model: HealthPageModel,
  meta: { projectName: string; organizationName: string | null; generatedAt: Date },
): HealthReport {
  const ready = healthReadiness(model) === "ready";
  const groups = ready ? groupByKind(model.signals, chainFolding(model.workflows)) : [];
  return {
    projectName: meta.projectName,
    organizationName: meta.organizationName,
    windowLabel: model.windowDays === 7 ? "Last 7 days" : `Last ${model.windowDays} days`,
    generatedOn: meta.generatedAt.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }),
    runs: `${formatCount(model.turns)} ${model.turns === 1 ? "run" : "runs"}`,
    source: sourceBadgeText(model.sourceMode) ?? "From the Ratel SDK",
    ready,
    verdict: verdictOf(model, groups),
    readings: model.tiles.map(reading),
    shapes: ready
      ? model.shapes.map((shape) => ({
          key: shape.shape,
          label: shape.label,
          description: shape.description,
          share: `${Math.round(shape.share * 100)}%`,
          width: Math.max(0, Math.min(100, shape.share * 100)),
          count: formatCount(shape.count),
        }))
      : [],
    problems: groups.map(problem),
    problemsSpan: runWindowLabel(model),
    hiddenProblems: model.lockedCount,
    workflows: ready
      ? (model.workflows?.items ?? []).map((row) => {
          const status = workflowStatus(row);
          return {
            id: row.id,
            name: row.name,
            steps: row.steps.map((step) => step.label).join(" → "),
            runs: formatCount(row.runs),
            finish: `${Math.round(row.completion * 100)}%`,
            time: formatWorkflowTime(row.medianMs),
            status,
            statusLabel: WORKFLOW_STATUS_LABEL[status],
          };
        })
      : [],
  };
}
