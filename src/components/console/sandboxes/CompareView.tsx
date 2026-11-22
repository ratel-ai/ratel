"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { DotLoaderLazy } from "@ratel/design-system/dot-loader-lazy";
import { X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatDuration, formatInteger } from "@/lib/synthesis/traces/v2/format";
import { type ArmTotals, compareSummary, outputDiff } from "@/lib/views/sandboxes/replay";
import { runStatus, traceHref } from "./types";
import type { CompareArmState, CompareState } from "./useCompare";

/**
 * Compare over recorded items (RC-1103): per item, the baseline (code
 * defaults) and the candidate (the edits) side by side with the output diff,
 * tokens, cost and latency; the summary row adds them up. No scores and no
 * pass or fail: the reader judges the diff.
 */
export function CompareView({
  projectId,
  state,
  onStop,
  onClose,
}: {
  projectId: string;
  state: CompareState;
  onStop: () => void;
  onClose: () => void;
}) {
  const summary = compareSummary(state.rows);
  const finished = state.rows.filter(
    (row) => isEnded(row.baseline) && isEnded(row.candidate),
  ).length;
  const running = state.phase === "resolving" || state.phase === "running";

  return (
    <section aria-label="Compare" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-fg">Compare</h2>
        <span className="text-ui text-fg-muted tabular-nums">
          {state.phase === "resolving"
            ? "Reading the recorded items…"
            : `${finished} of ${state.rows.length} items done · candidate: ${state.overrides.length > 0 ? state.overrides.join(", ") : "no changes (same as baseline)"}`}
        </span>
        {running ? <DotLoaderLazy label="Comparing" size="sm" /> : null}
        <span className="ml-auto flex items-center gap-2">
          {running ? (
            <Button size="sm" onClick={onStop}>
              Stop after the running items
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close the compare">
            <X className="size-3.5" aria-hidden />
            Close
          </Button>
        </span>
      </div>
      <p className="text-xs text-fg-subtle">
        Tokens, cost and latency: baseline above, candidate below. Each run is a replay of its
        item&apos;s trace.
      </p>
      {state.error ? <p className="text-ui text-warning">{state.error}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[60rem] border-collapse text-ui">
          <caption className="sr-only">Baseline and candidate output per recorded item</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs text-fg-subtle">
              <th scope="col" className="px-3 py-2 font-medium">
                Item
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Baseline (code)
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Candidate (edits)
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Output diff
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Tokens
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Cost
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Latency
              </th>
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row) => {
              const both = row.baseline.status === "ok" && row.candidate.status === "ok";
              const diff = both ? outputDiff(row.baseline.output, row.candidate.output) : null;
              return (
                <tr key={row.spanId} className="border-b border-line align-top last:border-b-0">
                  <th scope="row" className="max-w-48 px-3 py-2.5 text-left font-normal">
                    <span className="block truncate text-fg" title={row.label}>
                      {row.label}
                    </span>
                    <Link
                      href={traceHref(projectId, row.sourceTraceId)}
                      className="text-xs text-fg-subtle underline-offset-2 hover:text-fg hover:underline"
                    >
                      Recorded trace
                    </Link>
                  </th>
                  <td className="max-w-64 px-3 py-2.5">
                    <ArmCell projectId={projectId} arm={row.baseline} />
                  </td>
                  <td className="max-w-64 px-3 py-2.5">
                    <ArmCell projectId={projectId} arm={row.candidate} />
                  </td>
                  <td className="max-w-72 px-3 py-2.5">
                    {diff === null ? (
                      <span className="text-fg-subtle">…</span>
                    ) : diff.same ? (
                      <span className="text-fg-muted">Same output</span>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {diff.changes.map((change) => (
                          <li key={change.path} className="font-mono text-xs break-words">
                            {change.path ? (
                              <span className="text-fg-subtle">{change.path}: </span>
                            ) : null}
                            <span className="text-fg-muted line-through decoration-fg-faint">
                              {short(change.baseline)}
                            </span>
                            <span className="text-fg-subtle"> → </span>
                            <span className="text-fg">{short(change.candidate)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <Pair align values={[tokens(row.baseline), tokens(row.candidate)]} />
                  <Pair align values={[cost(row.baseline), cost(row.candidate)]} />
                  <Pair align values={[latency(row.baseline), latency(row.candidate)]} />
                </tr>
              );
            })}
          </tbody>
          {state.rows.length > 0 ? (
            <tfoot>
              <tr className="border-t border-line-strong bg-raised align-top">
                <th scope="row" className="px-3 py-2.5 text-left font-medium text-fg">
                  All items
                </th>
                <td className="px-3 py-2.5 text-fg-muted">
                  <Totals totals={summary.baseline} />
                </td>
                <td className="px-3 py-2.5 text-fg-muted">
                  <Totals totals={summary.candidate} />
                </td>
                <td className="px-3 py-2.5 text-fg">
                  {summary.compared === 0
                    ? "…"
                    : `${summary.changed} of ${summary.compared} outputs changed`}
                </td>
                <Pair
                  align
                  values={[
                    formatInteger(summary.baseline.inputTokens + summary.baseline.outputTokens),
                    formatInteger(summary.candidate.inputTokens + summary.candidate.outputTokens),
                  ]}
                />
                <Pair
                  align
                  values={[usd(summary.baseline.costUsd), usd(summary.candidate.costUsd)]}
                />
                <Pair
                  align
                  values={[avgLatency(summary.baseline), avgLatency(summary.candidate)]}
                  note="avg"
                />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </section>
  );
}

function ArmCell({ projectId, arm }: { projectId: string; arm: CompareArmState }) {
  const status = runStatus(arm.status);
  if (arm.status !== "ok") {
    return (
      <span className="flex flex-col gap-1">
        <StatusDot tone={status.tone} label={status.label} />
        {arm.error ? <span className="text-xs text-danger">{arm.error}</span> : null}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1">
      <code className="line-clamp-4 font-mono text-xs break-words whitespace-pre-wrap text-fg">
        {short(arm.output, 240)}
      </code>
      {arm.traceId ? (
        <Link
          href={traceHref(projectId, arm.traceId)}
          className="text-xs text-fg-subtle underline-offset-2 hover:text-fg hover:underline"
        >
          Trace
        </Link>
      ) : null}
    </span>
  );
}

/** Baseline over candidate in one cell. */
function Pair({
  values,
  align = false,
  note,
}: {
  values: [ReactNode, ReactNode];
  align?: boolean;
  note?: string;
}) {
  return (
    <td className={cn("px-3 py-2.5 whitespace-nowrap tabular-nums", align && "text-right")}>
      <span className="block text-fg-muted" title="Baseline">
        {values[0]}
      </span>
      <span className="block text-fg" title="Candidate">
        {values[1]}
      </span>
      {note ? <span className="block text-xs text-fg-subtle">{note}</span> : null}
    </td>
  );
}

function Totals({ totals }: { totals: ArmTotals }) {
  return (
    <span className="tabular-nums">
      {totals.runs} done{totals.failed > 0 ? `, ${totals.failed} failed` : ""}
    </span>
  );
}

function isEnded(arm: CompareArmState): boolean {
  return arm.status !== "queued" && arm.status !== "running";
}

function tokens(arm: CompareArmState): string {
  if (!arm.metrics) return arm.status === "ok" ? "…" : "–";
  return formatInteger(arm.metrics.inputTokens + arm.metrics.outputTokens);
}

function cost(arm: CompareArmState): string {
  if (!arm.metrics) return arm.status === "ok" ? "…" : "–";
  return usd(arm.metrics.costUsd);
}

function latency(arm: CompareArmState): string {
  if (!arm.metrics || arm.metrics.latencyMs === null) return arm.status === "ok" ? "…" : "–";
  return formatDuration(arm.metrics.latencyMs);
}

/** Four decimals: one run costs fractions of a cent, and the arms differ there. */
function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function avgLatency(totals: ArmTotals): string {
  return totals.runs === 0 ? "–" : formatDuration(totals.latencyMs / totals.runs);
}

function short(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "none");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
