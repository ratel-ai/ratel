"use client";

import { Badge, StatusDot } from "@ratel/design-system/badge";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { StatRow } from "@ratel/design-system/stat-row";
import { EmptyState } from "@ratel/design-system/states";
import { Rows3 } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import type { Trial } from "@/lib/views/evals/domain/experiment";
import { evalHref, evalsHref } from "@/lib/views/evals/paths";
import type { RunGridRow, RunPageModel, RunVariantCell } from "@/lib/views/evals/run-page";
import { percent } from "@/lib/views/evals/score-chart";

const RESULT: Record<
  NonNullable<Trial["result"]>,
  { label: string; tone: "success" | "danger" | "warning" }
> = {
  pass: { label: "Pass", tone: "success" },
  fail: { label: "Fail", tone: "danger" },
  invalid: { label: "Invalid", tone: "warning" },
};

/**
 * One run of an eval: a row for each frozen row of its dataset, with the input and the expected
 * output, then for each variant the output, a column for each scorer and its trials. A matrix run
 * shows its variants side by side, the param values in the header. A trial opens next to the
 * baseline trial, with its trace and session replay.
 */
export function RunView({ model, evalName }: { model: RunPageModel; evalName: string }) {
  const matrix = model.variants.length > 1;
  const title = model.name ?? `Run of ${model.at.slice(0, 16).replace("T", " ")}`;
  return (
    <Page>
      <PageHeader
        title={title}
        crumbs={[
          { label: "Evals", href: evalsHref(model.projectId) },
          { label: evalName, href: evalHref(model.projectId, model.evalId) },
        ]}
        description={`${model.sandboxName}${model.commit ? ` at ${model.commit}` : ""} · ${model.at.slice(0, 16).replace("T", " ")} UTC`}
        actions={
          model.state === "running" ? (
            <Badge tone="info">Running</Badge>
          ) : (
            <Badge tone="neutral">Completed</Badge>
          )
        }
      />
      <PageBody wide>
        <StatRow
          stats={[
            { label: "Score", value: percent(model.score) },
            { label: "Passed trials", value: String(model.counts.pass) },
            { label: "Failed trials", value: String(model.counts.fail) },
            { label: "Invalid trials", value: String(model.counts.invalid) },
            ...(model.counts.open > 0
              ? [{ label: "Open trials", value: String(model.counts.open) }]
              : []),
          ]}
        />
        {model.rows.length === 0 ? (
          <EmptyState
            icon={Rows3}
            title="No row"
            description="This run froze no row of the eval."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-raised">
            <table className="w-full border-collapse text-ui">
              <caption className="sr-only">Rows of the run, with each variant side by side</caption>
              <thead>
                {matrix ? (
                  <tr className="border-b border-line">
                    <th colSpan={2} className="px-3 py-2" />
                    {model.variants.map((variant) => (
                      <th
                        key={variant.index}
                        colSpan={model.scorers.length + 1}
                        scope="colgroup"
                        className="border-l border-line px-3 py-2 text-left font-medium text-fg"
                      >
                        <span className="flex items-center justify-between gap-3">
                          <code className="truncate font-mono text-xs">{variant.label}</code>
                          <span className="text-xs text-fg-muted tabular-nums">
                            {percent(variant.score)}
                          </span>
                        </span>
                      </th>
                    ))}
                  </tr>
                ) : null}
                <tr className="border-b border-line text-xs text-fg-subtle">
                  <th scope="col" className="min-w-48 px-3 py-2 text-left font-medium">
                    Row and input
                  </th>
                  <th scope="col" className="min-w-36 px-3 py-2 text-left font-medium">
                    Expected output
                  </th>
                  {model.variants.map((variant) => (
                    <Fragment key={variant.index}>
                      <th
                        scope="col"
                        className="min-w-44 border-l border-line px-3 py-2 text-left font-medium"
                      >
                        Output and trials
                      </th>
                      {model.scorers.map((scorer) => (
                        <th
                          key={scorer.name}
                          scope="col"
                          className="max-w-32 px-3 py-2 text-right font-medium"
                        >
                          {scorer.name}
                          {scorer.gating ? "" : " (scores only)"}
                        </th>
                      ))}
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {model.rows.map((row) => (
                  <GridRow key={row.versionId} row={row} scorers={model.scorers} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageBody>
    </Page>
  );
}

function GridRow({ row, scorers }: { row: RunGridRow; scorers: RunPageModel["scorers"] }) {
  return (
    <tr className="border-b border-line align-top last:border-b-0">
      <td className="px-3 py-2">
        <span className="block font-medium text-fg">{row.name}</span>
        <code className="line-clamp-3 font-mono text-xs break-all text-fg-muted">
          {row.input || "The row is gone."}
        </code>
      </td>
      <td className="px-3 py-2">
        {row.expectedOutput ? (
          <span className="line-clamp-3 text-fg-muted">{row.expectedOutput}</span>
        ) : (
          <span className="text-fg-faint">None</span>
        )}
      </td>
      {row.cells.map((cell) => (
        <Cell key={cell.variant} cell={cell} scorers={scorers} />
      ))}
    </tr>
  );
}

function Cell({ cell, scorers }: { cell: RunVariantCell; scorers: RunPageModel["scorers"] }) {
  return (
    <>
      <td className="border-l border-line px-3 py-2">
        {cell.output === null ? (
          <span className="text-fg-faint">{cell.counts.open > 0 ? "Running" : "No output"}</span>
        ) : (
          <span className="line-clamp-3 break-words text-fg">{cell.output}</span>
        )}
        <span className="mt-1.5 flex flex-wrap gap-1.5">
          {cell.trials.map((trial) => {
            const result = trial.result ? RESULT[trial.result] : null;
            return (
              <Link
                key={trial.trialId}
                href={trial.href}
                className="inline-flex items-center rounded-md border border-line px-1.5 py-0.5 hover:border-line-active"
                title={`Trial ${trial.index + 1}, next to the baseline`}
              >
                <StatusDot
                  tone={result?.tone ?? "info"}
                  label={`${trial.index + 1} ${result?.label ?? "Open"}`}
                  className="text-xs"
                />
              </Link>
            );
          })}
        </span>
      </td>
      {scorers.map((scorer) => {
        const score = cell.scorers[scorer.name];
        return (
          <td key={scorer.name} className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
            {score && score.rated > 0 ? (
              <span className={score.pass === score.rated ? "text-fg" : "text-fg-muted"}>
                {score.pass}/{score.rated}
              </span>
            ) : (
              <span className="text-fg-faint">Not scored</span>
            )}
          </td>
        );
      })}
    </>
  );
}
