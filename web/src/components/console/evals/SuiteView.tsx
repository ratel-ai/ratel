"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Field } from "@ratel/design-system/input";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { EmptyState } from "@ratel/design-system/states";
import { ListChecks } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import type { Verdict } from "@/lib/views/evals/domain/compare";
import type { ExperimentRow, ReadyVersion } from "@/lib/views/evals/page-model";
import { experimentHref, newEvalHref, suiteHref } from "@/lib/views/evals/paths";
import type {
  RunCell,
  ScorerCell,
  SuitePageModel,
  SuiteRowView,
} from "@/lib/views/evals/suite-page";
import { BaselineActions, type BaselineState } from "./BaselineActions";
import { ExperimentList, StateBadge } from "./ExperimentList";
import { RunEvals } from "./RunEvals";

const VERDICT: Record<Verdict, { label: string; tone: Tone }> = {
  regressed: { label: "Regressed", tone: "danger" },
  improved: { label: "Improved", tone: "success" },
  unchanged: { label: "Unchanged", tone: "neutral" },
  inconclusive: { label: "Inconclusive", tone: "warning" },
};

/**
 * The evals page (decision `suite-table`): one row for each eval with the score of the chosen
 * run, a column for each scorer, the delta against the pinned baseline and the invalid count. The
 * verdict and its rule are one line above the table.
 */
export function SuiteView({
  model,
  canEdit,
  versions,
  experiments,
  baseline,
  now,
  children,
}: {
  model: SuitePageModel;
  canEdit: boolean;
  versions: ReadyVersion[];
  experiments: ExperimentRow[];
  /** The pin, as the chosen run sees it. */
  baseline: BaselineState;
  /** ISO time the page was rendered, so relative times agree on server and client. */
  now: string;
  /** What the edition adds at the foot. */
  children?: ReactNode;
}) {
  const router = useRouter();
  const { projectId, runId } = model;
  return (
    <Page>
      <PageHeader
        title="Evals"
        description="Each eval runs its dataset on your agent and scores it. The table shows one run, and the change against the pinned baseline."
        actions={
          canEdit ? (
            <Link
              href={newEvalHref(projectId)}
              className={buttonVariants({ variant: "secondary" })}
            >
              New eval
            </Link>
          ) : null
        }
      />
      <PageBody>
        <Section
          title="Suite"
          actions={
            runId ? (
              <div className="flex flex-wrap items-center gap-2">
                <BaselineActions
                  projectId={projectId}
                  experimentId={runId}
                  baseline={baseline}
                  canEdit={canEdit && model.runState === "completed"}
                  showSuiteLink={false}
                />
                <Link
                  href={experimentHref(projectId, runId)}
                  className={buttonVariants({ variant: "secondary" })}
                >
                  Open the run
                </Link>
              </div>
            ) : null
          }
        >
          {model.runs.length > 0 ? (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Run">
                {(control) => (
                  <Select
                    id={control.id}
                    aria-label="Run"
                    value={runId ?? ""}
                    onValueChange={(id) => router.push(suiteHref(projectId, id))}
                    options={model.runs.map(({ id, label }) => ({ value: id, label }))}
                    className="w-96"
                  />
                )}
              </Field>
              {model.runState ? <StateBadge state={model.runState} /> : null}
            </div>
          ) : null}
          <VerdictLine model={model} />
          {model.rows.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title="No eval yet"
              description="Open a turn in Traces and save it as an eval case, or make a new eval."
            />
          ) : (
            <DataTable
              caption="Evals of the suite"
              columns={suiteColumns(model)}
              rows={model.rows}
              rowKey={(row) => row.evalId ?? "legacy"}
              onRowOpen={(row) => (row.href ? router.push(withRun(row.href, runId)) : undefined)}
            />
          )}
        </Section>
        {canEdit ? (
          <RunEvals projectId={projectId} versions={versions} evals={evalNames(model)} />
        ) : null}
        <ExperimentList
          projectId={projectId}
          experiments={experiments}
          baselineId={model.baselineId}
          now={now}
        />
        {children}
      </PageBody>
    </Page>
  );
}

/** The verdict of the run against the baseline, and its rule, on one line. */
function VerdictLine({ model }: { model: SuitePageModel }) {
  const { verdict } = model;
  if (!model.runId) return null;
  if (!verdict) {
    return (
      <p className="text-ui text-fg-muted" data-verdict="none">
        No baseline to compare with. Pin a completed run as the baseline to see the deltas.
      </p>
    );
  }
  if (!verdict.ok) {
    return (
      <p className="text-ui text-fg-muted" data-verdict="refused">
        <Badge tone="warning">Not compared</Badge> {verdict.message}
      </p>
    );
  }
  const shown = VERDICT[verdict.verdict];
  return (
    <div className="flex flex-col gap-1 text-ui" data-verdict={verdict.verdict}>
      <p className="text-fg-muted">
        <Badge tone={shown.tone}>{shown.label}</Badge> {verdict.rule}
      </p>
      {verdict.excludedMessage ? (
        <p className="text-xs text-fg-subtle">Left out: {verdict.excludedMessage}</p>
      ) : null}
    </div>
  );
}

function suiteColumns(model: SuitePageModel): Column<SuiteRowView>[] {
  return [
    {
      id: "eval",
      header: "Eval",
      cell: (row) =>
        row.href ? (
          <Link
            href={withRun(row.href, model.runId)}
            className="font-medium text-fg hover:underline"
          >
            {row.name}
          </Link>
        ) : (
          <span className="text-fg-muted">{row.name}</span>
        ),
    },
    {
      id: "task",
      header: "Task",
      hiddenBelow: "md",
      cell: (row) => <span className="text-fg-muted">{row.taskId ?? "—"}</span>,
    },
    {
      id: "cases",
      header: "Cases",
      align: "right",
      width: "6rem",
      cell: (row) => (
        <span title={`${row.approvedCases} approved, ${row.draftCases} drafts`}>
          {row.approvedCases}
          {row.draftCases > 0 ? <span className="text-fg-subtle"> +{row.draftCases}</span> : null}
        </span>
      ),
    },
    {
      id: "score",
      header: "Score",
      align: "right",
      width: "8rem",
      cell: (row) => <ScoreCell cell={row.run} />,
    },
    ...model.scorerColumns.map(
      (name): Column<SuiteRowView> => ({
        id: `scorer:${name}`,
        header: name,
        align: "right",
        width: "8rem",
        hiddenBelow: "lg",
        cell: (row) => <ScorerRate cell={row.run?.scorers[name]} />,
      }),
    ),
    {
      id: "delta",
      header: "Δ baseline",
      align: "right",
      width: "8rem",
      cell: (row) => <DeltaCell cell={row.run} />,
    },
    {
      id: "invalid",
      header: "Invalid",
      align: "right",
      width: "5rem",
      cell: (row) =>
        row.run ? (
          <span className={row.run.counts.invalid > 0 ? "text-warning" : "text-fg-subtle"}>
            {row.run.counts.invalid}
          </span>
        ) : null,
    },
  ];
}

function ScoreCell({ cell }: { cell: RunCell | null }) {
  if (!cell) return <span className="text-fg-subtle">Not in this run</span>;
  const { pass, fail } = cell.counts;
  return (
    <span className="tabular-nums" title={`${pass} passed, ${fail} failed`}>
      {percent(cell.score)}
      <span className="ml-1 text-xs text-fg-subtle">
        {pass}/{pass + fail}
      </span>
    </span>
  );
}

function ScorerRate({ cell }: { cell: ScorerCell | undefined }) {
  if (!cell) return <span className="text-fg-subtle">—</span>;
  return (
    <span className="tabular-nums" title={`${cell.pass} of ${cell.rated} scored trials passed`}>
      {percent(cell.passRate)}
      {cell.delta !== null ? <Delta value={cell.delta} small /> : null}
    </span>
  );
}

function DeltaCell({ cell }: { cell: RunCell | null }) {
  if (!cell) return null;
  if (cell.deltaReason) {
    return (
      <span className="text-xs text-fg-subtle" title={cell.deltaReason}>
        No delta
      </span>
    );
  }
  return cell.delta === null ? (
    <span className="text-fg-subtle">—</span>
  ) : (
    <Delta value={cell.delta} />
  );
}

/** A change of a rate, in points. */
export function Delta({ value, small = false }: { value: number; small?: boolean }) {
  const points = Math.round(value * 100);
  const tone = points > 0 ? "text-success" : points < 0 ? "text-danger" : "text-fg-subtle";
  return (
    <span className={`${tone} tabular-nums ${small ? "ml-1 text-xs" : ""}`}>
      {points > 0 ? "+" : ""}
      {points} pts
    </span>
  );
}

export function percent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function withRun(href: string, runId: string | null): string {
  return runId ? `${href}?run=${runId}` : href;
}

function evalNames({ rows }: SuitePageModel): string[] {
  return rows.flatMap(({ evalId, name }) => (evalId ? [name] : []));
}
