"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { Tooltip } from "@ratel/design-system/tooltip";
import { FlaskConical, Pin } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { RunDefaults } from "@/lib/views/evals/eval-form";
import type { EvalPageModel, EvalRunView } from "@/lib/views/evals/eval-page";
import { paramsText } from "@/lib/views/evals/eval-page";
import type { DialogData, EditDraft } from "@/lib/views/evals/pages-load";
import { evalsHref } from "@/lib/views/evals/paths";
import { percent, points } from "@/lib/views/evals/score-chart";
import { EvalDialog } from "./EvalDialog";
import { RunDialog } from "./RunDialog";
import { evalsApi, send } from "./request";
import { ScoreChart } from "./ScoreChart";

/**
 * One eval (decision `runs-per-eval`): what it runs, how each scorer moved over its runs, then
 * every run with what it used, its score and its delta against the pinned baseline. "New run"
 * starts a run with the defaults or with changes for that run only; "Edit" changes the eval.
 */
export function EvalView({
  model,
  dialog,
  defaults,
  edit,
  canEdit,
  now,
}: {
  model: EvalPageModel;
  dialog: DialogData;
  defaults: RunDefaults;
  edit: EditDraft;
  canEdit: boolean;
  now: string;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState(false);
  const { definition } = model;
  return (
    <Page>
      <PageHeader
        title={model.name}
        crumbs={[{ label: "Evals", href: evalsHref(model.projectId) }]}
        actions={
          canEdit ? (
            <>
              <Button onClick={() => setEditing(true)}>Edit</Button>
              <Button variant="primary" onClick={() => setRunning(true)}>
                New run
              </Button>
            </>
          ) : null
        }
      />
      <PageBody wide>
        <dl className="grid gap-x-8 gap-y-3 rounded-lg border border-line bg-raised px-4 py-3 text-ui sm:grid-cols-2 xl:grid-cols-4">
          <Term label="Dataset">
            <Link href={definition.dataset.href} className="text-fg hover:underline">
              {definition.dataset.name}
            </Link>
            {definition.dataset.kindLabel ? (
              <span className="text-fg-subtle"> · {definition.dataset.kindLabel}</span>
            ) : null}
          </Term>
          <Term label="Runtime">{definition.runtime.text}</Term>
          <Term label="Scorers">
            {definition.scorers.length === 0
              ? "None"
              : definition.scorers.map((scorer) => scorer.name).join(", ")}
          </Term>
          <Term label="Trials and params">
            {definition.trials} {definition.trials === 1 ? "trial" : "trials"} of each row
            {definition.combinations > 0
              ? ` · matrix (${definition.combinations})`
              : Object.keys(definition.params).length > 0
                ? ` · ${paramsText(definition.params)}`
                : ""}
          </Term>
        </dl>
        <ScoreChart
          chart={model.chart}
          label={`Pass rate of each scorer of ${model.name}`}
          emptyTitle="No run yet"
          emptyDescription="A line shows how each scorer moves over the runs. Start a run with New run."
        />
        <RunsTable model={model} canEdit={canEdit} now={now} onOpen={(href) => router.push(href)} />
      </PageBody>
      {canEdit ? (
        <>
          <RunDialog
            key={running ? "run-open" : "run-closed"}
            projectId={model.projectId}
            evalId={model.evalId}
            evalName={model.name}
            defaults={defaults}
            dialog={dialog}
            open={running}
            onOpenChange={setRunning}
          />
          <EvalDialog
            key={editing ? "edit-open" : "edit-closed"}
            projectId={model.projectId}
            dialog={dialog}
            edit={edit}
            open={editing}
            onOpenChange={setEditing}
          />
        </>
      ) : null}
    </Page>
  );
}

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="min-w-0 truncate text-fg">{children}</dd>
    </div>
  );
}

function RunsTable({
  model,
  canEdit,
  now,
  onOpen,
}: {
  model: EvalPageModel;
  canEdit: boolean;
  now: string;
  onOpen: (href: string) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  async function baseline(run: EvalRunView) {
    setPending(run.runId);
    const path = `${evalsApi(model.projectId)}/baseline`;
    const answer = run.isBaseline
      ? await send("DELETE", `${path}?experimentId=${run.runId}`)
      : await send("PUT", path, { experimentId: run.runId });
    setPending(null);
    if (!answer.ok) {
      toast({ title: "The baseline did not change.", description: answer.message, tone: "danger" });
      return;
    }
    toast({
      title: run.isBaseline ? "Baseline unpinned." : "Pinned as the baseline.",
      tone: "success",
    });
    router.refresh();
  }
  const columns: Column<EvalRunView>[] = [
    {
      id: "run",
      header: "Run",
      width: "13rem",
      cell: (run) => (
        <span className="flex flex-col">
          <Link href={run.href} className="truncate font-medium text-fg hover:underline">
            {run.name ?? formatRelativeTime(run.at, now)}
          </Link>
          <span className="text-xs text-fg-subtle" title={run.at}>
            {run.name ? formatRelativeTime(run.at, now) : run.at.slice(0, 16).replace("T", " ")}
            {run.state === "running" ? " · running" : ""}
            {run.changed.length > 0 ? ` · changed: ${run.changed.join(", ")}` : ""}
          </span>
        </span>
      ),
    },
    {
      id: "dataset",
      header: "Dataset",
      hiddenBelow: "md",
      cell: (run) => (
        <span className="flex flex-col">
          {run.dataset.href ? (
            <Link href={run.dataset.href} className="truncate text-fg hover:underline">
              {run.dataset.name}
            </Link>
          ) : (
            <span className="truncate text-fg">{run.dataset.name}</span>
          )}
          <span className="text-xs text-fg-subtle">{run.dataset.rows} frozen rows</span>
        </span>
      ),
    },
    {
      id: "runtime",
      header: "Runtime",
      width: "11rem",
      hiddenBelow: "lg",
      cell: (run) => (
        <span className="flex flex-col">
          <span className="truncate text-fg">{run.runtime.sandboxName}</span>
          <code className="font-mono text-xs text-fg-subtle">
            {run.runtime.commit || run.runtime.versionId.slice(0, 8)}
          </code>
        </span>
      ),
    },
    {
      id: "scorers",
      header: "Scorers",
      width: "6rem",
      hiddenBelow: "lg",
      cell: (run) => (
        <Tooltip content={run.scorers.join(", ") || "No scorer"}>
          <span className="tabular-nums text-fg-muted">{run.scorers.length}</span>
        </Tooltip>
      ),
    },
    {
      id: "params",
      header: "Params",
      width: "11rem",
      hiddenBelow: "md",
      cell: (run) => (
        <span className="block truncate text-fg-muted" title={run.params}>
          {run.params}
        </span>
      ),
    },
    {
      id: "score",
      header: "Score",
      width: "6rem",
      align: "right",
      cell: (run) =>
        run.score === null ? (
          <span className="text-fg-faint">No score</span>
        ) : (
          <span className="tabular-nums">{percent(run.score)}</span>
        ),
    },
    {
      id: "delta",
      header: "Against baseline",
      width: "9rem",
      align: "right",
      cell: (run) =>
        run.isBaseline ? (
          <Badge tone="accent">
            <Pin className="size-3" aria-hidden /> Baseline
          </Badge>
        ) : run.delta !== null ? (
          <span
            className={
              run.delta > 0
                ? "text-success tabular-nums"
                : run.delta < 0
                  ? "text-danger tabular-nums"
                  : "text-fg-muted tabular-nums"
            }
          >
            {run.delta > 0 ? "▲ " : run.delta < 0 ? "▼ " : ""}
            {points(run.delta)}
          </span>
        ) : run.deltaNote ? (
          <Tooltip content={run.deltaNote}>
            <span className="text-fg-subtle">No delta</span>
          </Tooltip>
        ) : (
          <span className="text-fg-faint">No baseline</span>
        ),
    },
    {
      id: "invalid",
      header: "Invalid",
      width: "5rem",
      align: "right",
      hiddenBelow: "sm",
      cell: (run) => (
        <span
          className={run.invalid > 0 ? "text-warning tabular-nums" : "text-fg-faint tabular-nums"}
        >
          {run.invalid}
        </span>
      ),
    },
    ...(canEdit
      ? [
          {
            id: "pin",
            header: <span className="sr-only">Baseline</span>,
            width: "7rem",
            cell: (run: EvalRunView) =>
              run.isBaseline || run.canPin ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={pending === run.runId}
                  onClick={() => baseline(run)}
                >
                  {run.isBaseline ? "Unpin" : "Pin"}
                </Button>
              ) : null,
          },
        ]
      : []),
  ];
  return (
    <section className="flex flex-col gap-3" aria-labelledby="runs-heading">
      <h2 id="runs-heading" className="text-sm font-semibold text-fg">
        Runs
      </h2>
      <DataTable
        caption={`Runs of ${model.name}`}
        columns={columns}
        rows={model.runs}
        rowKey={(run) => run.runId}
        onRowOpen={(run) => onOpen(run.href)}
        empty={
          <EmptyState
            icon={FlaskConical}
            title="No run yet"
            description="New run starts one with the defaults of the eval, or with changes for that run."
          />
        }
      />
      <p className="text-xs text-fg-subtle">{model.rule}</p>
    </section>
  );
}
