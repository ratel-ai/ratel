"use client";

import { Button } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { FilterBar, SearchInput } from "@ratel/design-system/filter-bar";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { type EvalListRow, type EvalsPageModel, filterEvals } from "@/lib/views/evals/evals-page";
import type { DialogData } from "@/lib/views/evals/pages-load";
import { percent } from "@/lib/views/evals/score-chart";
import { EvalDialog } from "./EvalDialog";
import { ScoreChart } from "./ScoreChart";
import { SlotMark } from "./SlotMark";

/**
 * The Evals page (decision `runs-per-eval`): how each eval scores over its runs, one line each,
 * then the evals with four columns. "New eval" opens the dialog; a run starts inside an eval.
 */
export function EvalsList({
  model,
  dialog,
  canEdit,
  openNew,
}: {
  model: EvalsPageModel;
  dialog: DialogData;
  canEdit: boolean;
  /** Opens "New eval" at once (the old address of the new-eval page). */
  openNew: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(openNew);
  const rows = filterEvals(model.rows, search);
  const columns: Column<EvalListRow>[] = [
    {
      id: "name",
      header: "Name",
      cell: (row) => (
        <span className="flex items-center gap-2">
          <SlotMark slot={row.slot} />
          <Link href={row.href} className="font-medium text-fg hover:underline">
            {row.name}
          </Link>
        </span>
      ),
    },
    {
      id: "cases",
      header: "Cases",
      width: "11rem",
      align: "right",
      cell: (row) => <span className="text-fg-muted tabular-nums">{row.cases}</span>,
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
        description="How each eval scores over its runs."
        actions={
          canEdit ? (
            <Button variant="primary" onClick={() => setOpen(true)}>
              New eval
            </Button>
          ) : null
        }
      />
      <PageBody wide>
        <ScoreChart
          chart={model.chart}
          label="Score of each eval"
          emptyTitle="No run yet"
          emptyDescription="A line shows the score of an eval over its runs. Open an eval and start a run."
        />
        <div className="flex flex-col gap-3">
          <FilterBar
            search={
              <SearchInput
                value={search}
                onValueChange={setSearch}
                placeholder="Filter evals"
                label="Filter evals"
              />
            }
          />
          <DataTable
            caption="Evals"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.evalId}
            onRowOpen={(row) => router.push(row.href)}
            empty={
              model.rows.length === 0 ? (
                <EmptyState
                  icon={FlaskConical}
                  title="No eval yet"
                  description={`An eval runs a dataset on a sandbox and scores each answer.${canEdit ? " Use New eval." : ""}`}
                />
              ) : (
                <EmptyState
                  icon={FlaskConical}
                  title="No eval matches"
                  description="Change the filter."
                />
              )
            }
          />
        </div>
      </PageBody>
      {canEdit ? (
        <EvalDialog
          key={open ? "open" : "closed"}
          projectId={model.projectId}
          dialog={dialog}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </Page>
  );
}
