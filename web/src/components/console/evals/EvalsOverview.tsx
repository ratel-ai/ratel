"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import { FilterBar, SearchInput } from "@ratel/design-system/filter-bar";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { FlaskConical, LineChart } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import {
  type EvalsPage,
  type EvalsTableRow,
  filterEvals,
  percent,
} from "@/lib/views/evals/evals-page";
import { NewEvalDialog, type NewEvalOptions } from "./NewEvalDialog";
import { ScoreChart } from "./ScoreChart";

/**
 * The Evals page: how each eval scores over its runs (one line for each eval), then the evals in
 * a table of four columns. Creating is one click away ("New eval"); running is on each eval.
 */
export function EvalsOverview({
  model,
  options,
  canEdit,
  openNew = false,
  now,
  children,
}: {
  model: EvalsPage;
  options: NewEvalOptions;
  canEdit: boolean;
  /** The old address of the new-eval page opens the dialog. */
  openNew?: boolean;
  now: string;
  /** The section of the edition at the foot of the page (who judges evals). */
  children?: ReactNode;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const { chart } = model;
  const columns: Column<EvalsTableRow>[] = [
    {
      id: "name",
      header: "Name",
      cell: (row) => (
        <Link href={row.href} className="font-medium text-fg hover:underline">
          {row.name}
        </Link>
      ),
    },
    {
      id: "cases",
      header: "Cases",
      width: "7rem",
      align: "right",
      cell: (row) => <span className="tabular-nums">{row.cases}</span>,
    },
    {
      id: "scorers",
      header: "Scorers",
      width: "7rem",
      align: "right",
      cell: (row) => <span className="tabular-nums">{row.scorers}</span>,
    },
    {
      id: "baseline",
      header: "Baseline score",
      width: "9rem",
      align: "right",
      cell: (row) =>
        row.baselineScore === null ? (
          <span className="text-fg-faint">No baseline</span>
        ) : (
          <span className="tabular-nums">{percent(row.baselineScore)}</span>
        ),
    },
  ];
  return (
    <Page>
      <PageHeader
        title="Evals"
        description="How each eval scores over its runs. Open an eval to start a run."
        actions={
          canEdit ? (
            <NewEvalDialog projectId={model.projectId} options={options} defaultOpen={openNew} />
          ) : null
        }
      />
      <PageBody>
        <section
          aria-label="Score of each eval over time"
          className="rounded-lg border border-line p-4"
        >
          {chart.runs === 0 ? (
            <EmptyState
              icon={LineChart}
              title="No run yet"
              description="Each run of an eval adds a point here. Open an eval and start a run."
            />
          ) : (
            <div className="flex flex-col gap-2">
              <ScoreChart series={chart.series} label="Score of each eval by run" now={now} />
              {chart.runs === 1 ? (
                <p className="text-xs text-fg-subtle">
                  One run so far: the next run of the eval draws its line.
                </p>
              ) : null}
              {chart.hidden > 0 ? (
                <p className="text-xs text-fg-subtle">
                  The chart shows the six evals with the newest runs.{" "}
                  {chart.hidden === 1 ? "1 more eval is" : `${chart.hidden} more evals are`} in the
                  table.
                </p>
              ) : null}
            </div>
          )}
        </section>
        <FilterBar
          search={
            <SearchInput
              value={filter}
              onValueChange={setFilter}
              placeholder="Filter evals"
              label="Filter evals"
            />
          }
        />
        <DataTable
          caption="Evals"
          columns={columns}
          rows={filterEvals(model.rows, filter)}
          rowKey={(row) => row.evalId}
          onRowOpen={(row) => router.push(row.href)}
          empty={
            <EmptyState
              icon={FlaskConical}
              title={model.rows.length === 0 ? "No eval yet" : "No eval matches"}
              description={
                model.rows.length === 0
                  ? "New eval joins a dataset, a runtime and scorers."
                  : `No eval name has "${filter.trim()}".`
              }
            />
          }
        />
        {children}
      </PageBody>
    </Page>
  );
}
