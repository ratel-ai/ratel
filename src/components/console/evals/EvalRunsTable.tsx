"use client";

import { Badge } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { EmptyState } from "@ratel/design-system/states";
import { History } from "lucide-react";
import { useRouter } from "next/navigation";
import type { EvalResult, EvalRun } from "@/lib/views/evals/domain/types";
import { evalHref } from "@/lib/views/evals/paths";
import { totalsLine } from "@/lib/views/evals/test-view";
import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import { SCORER_KINDS } from "@/lib/views/task-scorers/types";
import { CellIcon, ResultStatus, RUN_KIND_LABELS } from "./marks";

type Row = { run: EvalRun; result: EvalResult };
const TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

/** One eval's runs (D2): a check, cross or dot per scorer, time and cost, the result. A row opens the eval at that run. */
export function EvalRunsTable({
  projectId,
  evalId,
  rows,
}: {
  projectId: string;
  evalId: string;
  rows: readonly Row[];
}) {
  const router = useRouter();
  const used = new Set(
    rows.flatMap(({ result }) => result.verdicts.map((verdict) => verdict.kind)),
  );
  const columns: Column<Row>[] = [
    {
      id: "when",
      header: "When",
      width: "9rem",
      cell: ({ run }) => <span className="tabular-nums">{TIME.format(run.createdAt)}</span>,
    },
    {
      id: "run",
      header: "Run",
      cell: ({ run }) =>
        run.kind === "simulation" ? (
          <span className="flex items-center gap-2">
            <Badge>Simulation</Badge>
            {run.fixId}
          </span>
        ) : (
          RUN_KIND_LABELS[run.kind]
        ),
    },
    ...SCORER_KINDS.filter((kind) => used.has(kind)).map(
      (kind): Column<Row> => ({
        id: kind,
        header: SCORER_LABELS[kind],
        width: "5.5rem",
        cell: ({ result }) => {
          const verdict = result.verdicts.find((entry) => entry.kind === kind);
          return <CellIcon mark={verdict && verdict.status !== "skip" ? verdict.status : "dot"} />;
        },
      }),
    ),
    {
      id: "totals",
      header: "Time · cost",
      width: "11rem",
      align: "right",
      cell: ({ result }) => (
        <span className="text-fg-muted tabular-nums">
          {totalsLine({ ...result, toolCalls: null })}
        </span>
      ),
    },
    {
      id: "result",
      header: "Result",
      width: "8rem",
      cell: ({ result }) => (
        <ResultStatus
          mark={result.passed === true ? "pass" : result.passed === false ? "fail" : "error"}
        />
      ),
    },
  ];
  return (
    <DataTable
      caption="Runs of this eval"
      columns={columns}
      rows={rows}
      rowKey={({ result }) => result.id}
      onRowOpen={({ run }) => router.push(evalHref(projectId, evalId, { run: run.id }))}
      empty={
        <EmptyState
          icon={History}
          title="No runs yet"
          description="Run all on the Evals page to see this eval's history."
        />
      }
    />
  );
}
