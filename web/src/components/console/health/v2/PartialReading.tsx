"use client";

import { Badge } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Section } from "@ratel/design-system/section";
import { type StatProps, StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { Tooltip } from "@ratel/design-system/tooltip";
import { ArrowUpRight } from "lucide-react";
import { OpenImportButtonV2 } from "@/components/console/health/v2/OpenImportButtonV2";
import type {
  ModelFact,
  PartialReading as PartialReadingModel,
  PartialStep,
} from "@/lib/readings/trace-signals/partial-reading";
import type { ImportSource } from "@/lib/views/health/imports-types";
import { SOURCE_LABEL } from "@/lib/views/health/imports-types";

/** The docs guide on sending tool calls and content in the runs Ratel imports. */
export const IMPORT_CAPTURE_GUIDE_URL = "https://www.ratel.sh/docs/cloud/import-tool-calls";

const LIKELY_TOOL_HINT =
  "At least half of the calls of this step hold no other step, as a tool call does. Mark tool spans in your traces to confirm it.";

/**
 * Agent health for imported runs with no tool call it recognises: what their
 * spans still say, for the selected window. A notice says what is missing and
 * links to the guide; then the run tiles, the steps the runs are made of and
 * the models they call. No issue, task or score: those read tool calls.
 */
export function PartialReading({
  reading,
  source,
  canImport,
}: {
  reading: PartialReadingModel;
  source: ImportSource;
  canImport: boolean;
}) {
  return (
    <div className="flex flex-col gap-8" data-health-partial-reading={reading.runs}>
      <Callout
        title="Partial reading: no tool calls recognised"
        action={
          <div className="flex items-center gap-2">
            <a
              href={IMPORT_CAPTURE_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-fg underline-offset-4 hover:underline"
            >
              How to send tool calls
              <ArrowUpRight className="size-3.5" aria-hidden />
            </a>
            {canImport ? <OpenImportButtonV2 /> : null}
          </div>
        }
      >
        The runs imported from {SOURCE_LABEL[source]} mark no step as a tool call, so issues, tasks
        and the score cannot be read yet. Here is what their steps, timing, errors and models say.
      </Callout>
      {reading.runs === 0 ? (
        <div className="rounded-lg border border-line bg-raised">
          <EmptyState
            title={`No runs in the last ${reading.windowDays} days`}
            description="The imported runs started earlier. Pick a wider window to read them."
          />
        </div>
      ) : (
        <>
          <StatRow stats={runStats(reading)} />
          <Section
            title="Steps your runs take"
            description="Every span under a run, by name. A step marked likely tool holds no other step in at least half of its calls."
            surface
          >
            <DataTable
              caption="Steps your runs take"
              columns={STEP_COLUMNS}
              rows={reading.steps}
              rowKey={(s) => s.name}
              density="compact"
              empty={
                <EmptyState
                  title="No steps recorded"
                  description="The runs in this window hold only model calls. No step was recorded under them."
                />
              }
            />
          </Section>
          {reading.models.length > 0 ? (
            <Section
              title="Models"
              description={
                reading.tokensPerRun === null
                  ? undefined
                  : `${compact(reading.tokensPerRun)} tokens per run on average.`
              }
              surface
            >
              <DataTable
                caption="Models"
                columns={MODEL_COLUMNS}
                rows={reading.models}
                rowKey={(m) => m.model}
                density="compact"
              />
            </Section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Five tiles at most (StatRow); tokens per run sit with the models. */
function runStats(r: PartialReadingModel): StatProps[] {
  return [
    { label: "Runs", value: count(r.runs), hint: `in the last ${r.windowDays} days` },
    { label: "Completed", value: percent(r.completedShare), hint: "runs with no failed step" },
    {
      label: "Failed calls",
      value: count(r.failedCalls),
      hint: `of ${count(r.calls)} steps and model calls`,
    },
    { label: "Model round trips", value: decimal(r.roundTripsPerRun), hint: "per run" },
    { label: "Run time p95", value: duration(r.p95RunMs) },
  ];
}

const STEP_COLUMNS: readonly Column<PartialStep>[] = [
  {
    id: "name",
    header: "Step",
    cell: (s) => (
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-xs text-fg">{s.name}</span>
        {s.likelyTool ? (
          <Tooltip content={LIKELY_TOOL_HINT}>
            <Badge tone="info">Likely tool</Badge>
          </Tooltip>
        ) : null}
      </span>
    ),
  },
  { id: "calls", header: "Calls", align: "right", width: "6rem", cell: (s) => count(s.calls) },
  {
    id: "failed",
    header: "Failed",
    align: "right",
    width: "6rem",
    cell: (s) => (s.failed > 0 ? count(s.failed) : "–"),
  },
  {
    id: "p95",
    header: "p95",
    align: "right",
    width: "6rem",
    hiddenBelow: "sm",
    cell: (s) => duration(s.p95Ms),
  },
];

const MODEL_COLUMNS: readonly Column<ModelFact>[] = [
  {
    id: "model",
    header: "Model",
    cell: (m) => <span className="font-mono text-xs text-fg">{m.model}</span>,
  },
  { id: "calls", header: "Calls", align: "right", width: "6rem", cell: (m) => count(m.calls) },
  {
    id: "tokens",
    header: "Tokens",
    align: "right",
    width: "7rem",
    cell: (m) => (m.tokens === null ? "–" : compact(m.tokens)),
  },
];

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function compact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}

function percent(share: number | null): string {
  return share === null ? "–" : `${Math.round(share * 100)}%`;
}

function decimal(n: number | null): string {
  return n === null ? "–" : n.toFixed(1);
}

function duration(ms: number | null): string {
  if (ms === null) return "–";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}
