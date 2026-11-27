"use client";

import { Badge } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { LineChart, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { EvalPage, RunTableRow } from "@/lib/views/evals/eval-page";
import { percent } from "@/lib/views/evals/evals-page";
import { evalsHref } from "@/lib/views/evals/paths";
import { BaselineActions } from "./BaselineActions";
import { NewRunDialog, type NewRunOptions } from "./NewRunDialog";
import { ScoreChart } from "./ScoreChart";

/**
 * One eval (decision `runs-per-eval`): its definition with "Edit", a chart with the mean and one
 * line for each scorer over its runs, then the table of its runs. "New run" starts a run with the
 * defaults or with changes for that run only.
 */
export function EvalPageView({
  model,
  options,
  canEdit,
  now,
}: {
  model: EvalPage;
  options: NewRunOptions;
  canEdit: boolean;
  now: string;
}) {
  const router = useRouter();
  const { definition } = model;
  const columns: Column<RunTableRow>[] = [
    {
      id: "run",
      header: "Run",
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <Link href={row.href} className="truncate font-medium text-fg hover:underline">
              {row.title === row.at ? formatRelativeTime(row.at, now) : row.title}
            </Link>
            {row.isBaseline ? <Badge tone="accent">Baseline</Badge> : null}
            {row.running ? <Badge tone="info">Running</Badge> : null}
          </span>
          {row.changed.length > 0 ? (
            <span
              className="block max-w-[24rem] truncate text-xs text-fg-subtle"
              title={row.changed.join(", ")}
            >
              Changed: {row.changed.join(", ")}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "dataset",
      header: "Dataset",
      width: "11rem",
      hiddenBelow: "md",
      cell: (row) => (
        <span className="flex flex-col text-ui">
          {row.dataset.href ? (
            <Link
              href={row.dataset.href}
              className="truncate text-fg-muted hover:text-fg hover:underline"
            >
              {row.dataset.name}
            </Link>
          ) : (
            <span className="truncate text-fg-muted">{row.dataset.name}</span>
          )}
          <span className="text-xs text-fg-subtle">
            {row.dataset.rows === 1 ? "1 frozen row" : `${row.dataset.rows} frozen rows`}
          </span>
        </span>
      ),
    },
    {
      id: "runtime",
      header: "Runtime",
      width: "11rem",
      hiddenBelow: "lg",
      cell: (row) => (
        <span className="flex flex-col">
          <span className="truncate text-fg-muted">{row.runtime.sandbox}</span>
          <code className="font-mono text-xs text-fg-subtle">
            {row.runtime.commit || row.runtime.version}
          </code>
        </span>
      ),
    },
    {
      id: "scorers",
      header: "Scorers",
      width: "5rem",
      align: "right",
      hiddenBelow: "lg",
      cell: (row) => <span className="tabular-nums">{row.scorers}</span>,
    },
    {
      id: "params",
      header: "Parameters",
      width: "10rem",
      hiddenBelow: "md",
      cell: (row) => (
        <span className="block truncate font-mono text-xs text-fg-muted" title={row.params}>
          {row.params}
        </span>
      ),
    },
    {
      id: "score",
      header: "Score",
      width: "5rem",
      align: "right",
      cell: (row) =>
        row.running ? (
          <span className="text-fg-faint">…</span>
        ) : (
          <span className="tabular-nums text-fg">{percent(row.score)}</span>
        ),
    },
    {
      id: "delta",
      header: "Delta",
      width: "6rem",
      align: "right",
      cell: (row) => <DeltaCell row={row} />,
    },
    {
      id: "invalid",
      header: "Invalid",
      width: "5rem",
      align: "right",
      hiddenBelow: "sm",
      cell: (row) => (
        <span
          className={row.invalid > 0 ? "tabular-nums text-warning" : "tabular-nums text-fg-faint"}
        >
          {row.invalid}
        </span>
      ),
    },
    {
      id: "baseline",
      header: <span className="sr-only">Baseline</span>,
      width: "9rem",
      align: "right",
      cell: (row) =>
        row.running ? null : (
          <BaselineActions
            projectId={model.projectId}
            experimentId={row.experimentId}
            baseline={row.isBaseline ? "this" : model.baselineId ? "other" : "none"}
            canEdit={canEdit}
          />
        ),
    },
  ];
  return (
    <Page>
      <PageHeader
        title={model.name}
        crumbs={[{ label: "Evals", href: evalsHref(model.projectId) }]}
        actions={
          canEdit ? (
            <>
              <Link
                href={`${evalsHref(model.projectId)}/${model.evalId}/edit`}
                className={buttonVariants({ variant: "secondary" })}
              >
                Edit
              </Link>
              <NewRunDialog
                projectId={model.projectId}
                evalId={model.evalId}
                options={options}
                now={now}
              />
            </>
          ) : null
        }
      />
      <PageBody>
        <dl className="grid gap-x-8 gap-y-2 text-ui sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Dataset">
            {definition.dataset ? (
              <Link href={definition.dataset.href} className="hover:underline">
                {definition.dataset.name}
                <span className="text-fg-subtle"> · {definition.dataset.kindLabel}</span>
              </Link>
            ) : (
              <span className="text-fg-faint">None</span>
            )}
          </Fact>
          <Fact label="Runtime">{definition.runtime}</Fact>
          <Fact label="Scorers">
            <span title={definition.scorers.join(", ")} className="truncate">
              {definition.scorers.length === 0 ? "None" : definition.scorers.join(", ")}
            </span>
          </Fact>
          <Fact label="Trials">
            {definition.trials}
            {definition.matrix ? (
              <span className="text-fg-subtle"> · {definition.matrix}</span>
            ) : null}
          </Fact>
        </dl>
        <section
          aria-label="Score of each scorer over time"
          className="rounded-lg border border-line p-4"
        >
          {model.chart.runs === 0 ? (
            <EmptyState
              icon={LineChart}
              title="No completed run yet"
              description="Each completed run adds a point for the mean and for each scorer."
            />
          ) : (
            <div className="flex flex-col gap-2">
              <ScoreChart
                series={model.chart.series}
                label="Mean and pass rate of each scorer by run"
                now={now}
              />
              {model.chart.runs === 1 ? (
                <p className="text-xs text-fg-subtle">
                  One run so far: the next run draws the lines.
                </p>
              ) : null}
            </div>
          )}
        </section>
        <DataTable
          caption="Runs"
          columns={columns}
          rows={model.runs}
          rowKey={(row) => row.experimentId}
          onRowOpen={(row) => router.push(row.href)}
          empty={
            <EmptyState
              icon={Play}
              title="No run yet"
              description="New run starts one with the defaults of the eval."
            />
          }
        />
      </PageBody>
    </Page>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="flex min-w-0 items-center text-fg">{children}</dd>
    </div>
  );
}

function DeltaCell({ row }: { row: RunTableRow }) {
  if (row.isBaseline) return <span className="text-fg-faint">—</span>;
  if (row.delta === null) {
    return (
      <span className="text-xs text-fg-faint" title={row.deltaNote ?? undefined}>
        {row.deltaNote === "No baseline" ? "No baseline" : "No delta"}
      </span>
    );
  }
  const points = Math.round(row.delta * 100);
  const tone = points > 0 ? "text-success" : points < 0 ? "text-danger" : "text-fg-muted";
  return (
    <span className={`tabular-nums ${tone}`}>
      {points > 0 ? "+" : ""}
      {points} pts
    </span>
  );
}
