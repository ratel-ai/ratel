"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { ListChecks } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CaseChange } from "@/lib/views/evals/domain/compare";
import type { EvalScorer } from "@/lib/views/evals/domain/eval";
import type { TrialResult } from "@/lib/views/evals/domain/score";
import { caseHref, evalHref, evalsHref, suiteHref } from "@/lib/views/evals/paths";
import type { DatasetRow, EvalPageModel } from "@/lib/views/evals/suite-page";
import { ScorerFields } from "./ScorerFields";
import { Delta, percent } from "./SuiteView";

const CHANGE: Record<CaseChange, { label: string; tone: Tone }> = {
  regressed: { label: "Regressed", tone: "danger" },
  improved: { label: "Improved", tone: "success" },
  inconclusive: { label: "Inconclusive", tone: "warning" },
  added: { label: "New", tone: "info" },
  removed: { label: "Removed", tone: "info" },
  excluded: { label: "Other scorers", tone: "warning" },
  unchanged: { label: "Unchanged", tone: "neutral" },
};
const RESULT: Record<TrialResult, Tone> = { pass: "success", fail: "danger", invalid: "warning" };

/**
 * One eval (level 2): its definition, where the scorers are edited, and its dataset as a grid with
 * the output of the run, the expected output and a column for each scorer. A new eval has only
 * the definition.
 */
export function EvalView({ model, canEdit }: { model: EvalPageModel | NewEval; canEdit: boolean }) {
  const isNew = !("id" in model);
  return (
    <Page>
      <PageHeader
        title={isNew ? "New eval" : model.name}
        crumbs={[{ label: "Evals", href: evalsHref(model.projectId) }]}
        actions={
          !isNew && canEdit ? (
            <Link
              href={`${caseHref(model.projectId, "new")}?eval=${model.id}`}
              className={buttonVariants({ variant: "secondary" })}
            >
              New case
            </Link>
          ) : null
        }
      />
      <PageBody>
        <Definition model={model} canEdit={canEdit} />
        {isNew ? null : <Dataset model={model} />}
      </PageBody>
    </Page>
  );
}

/** What the page of a new eval knows. */
export type NewEval = { projectId: string };

function Definition({ model, canEdit }: { model: EvalPageModel | NewEval; canEdit: boolean }) {
  const router = useRouter();
  const existing = "id" in model ? model : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [taskId, setTaskId] = useState(existing?.taskId ?? "");
  const [sandboxName, setSandboxName] = useState(existing?.version.sandboxName ?? "");
  const [params, setParams] = useState(JSON.stringify(existing?.version.params ?? {}, null, 2));
  const [trials, setTrials] = useState(String(existing?.version.trials ?? 3));
  const [scorers, setScorers] = useState<EvalScorer[]>(existing?.version.scorers ?? []);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(params || "{}");
    } catch {
      return setProblem("The params must be a JSON object.");
    }
    setPending(true);
    setProblem(null);
    const base = `/api/projects/${model.projectId}/evals/definitions`;
    const body = {
      name,
      taskId: taskId.trim() || null,
      content: {
        sandboxName: sandboxName.trim() || null,
        params: parsed,
        trials: Number(trials),
        scorers,
      },
      ...(existing ? { base: existing.version.id } : {}),
    };
    try {
      const response = await fetch(existing ? `${base}/${existing.id}` : base, {
        method: existing ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const answer = (await response.json()) as {
        evalId?: string;
        number?: number;
        message?: string;
      };
      if (response.ok && answer.evalId) {
        toast({ title: `Version ${answer.number} of the eval is saved`, tone: "success" });
        if (!existing) return router.replace(evalHref(model.projectId, answer.evalId));
        router.refresh();
      } else {
        setProblem(answer.message ?? "The eval was not saved. Try again.");
      }
    } catch {
      setProblem("The eval was not saved. Try again.");
    }
    setPending(false);
  }

  return (
    <Section
      title="Definition"
      description={
        existing
          ? `Version ${existing.version.number}. A save with other content makes a new version: a run keeps the version that it started with.`
          : "The scorers score each case of the eval. A trial passes when each gating scorer passes."
      }
      actions={
        canEdit ? (
          <Button variant="primary" onClick={save} loading={pending}>
            {existing ? "Save the eval" : "Create the eval"}
          </Button>
        ) : null
      }
    >
      {problem ? (
        <Callout tone="danger" title="Not saved">
          {problem}
        </Callout>
      ) : null}
      <div className="grid max-w-3xl gap-4 md:grid-cols-2">
        <Field label="Name">
          {(control) => (
            <Input
              {...control}
              value={name}
              maxLength={100}
              disabled={!canEdit}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Task (its id, optional)">
          {(control) => (
            <Input
              {...control}
              value={taskId}
              disabled={!canEdit}
              onChange={(event) => setTaskId(event.target.value)}
            />
          )}
        </Field>
        <Field label="Sandbox (empty: the sandbox of the run)">
          {(control) => (
            <Input
              {...control}
              value={sandboxName}
              disabled={!canEdit}
              onChange={(event) => setSandboxName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Trials for each case">
          {(control) => (
            <Input
              {...control}
              type="number"
              min={1}
              max={20}
              value={trials}
              disabled={!canEdit}
              onChange={(event) => setTrials(event.target.value)}
            />
          )}
        </Field>
        <Field label="Default params (JSON)" className="md:col-span-2">
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              value={params}
              spellCheck={false}
              className="font-mono"
              disabled={!canEdit}
              onChange={(event) => setParams(event.target.value)}
            />
          )}
        </Field>
      </div>
      <ScorerFields scorers={scorers} onChange={setScorers} canEdit={canEdit} />
    </Section>
  );
}

function Dataset({ model }: { model: EvalPageModel }) {
  const router = useRouter();
  const scorerNames = model.version.scorers.map(({ name }) => name);
  return (
    <Section
      title="Dataset"
      description={
        model.runId
          ? "Each row is a case: its input, what the agent answered in the run, the expected output, and each scorer."
          : "Each row is a case. Run the suite to see the outputs and the scores."
      }
      actions={
        model.run ? (
          <div className="flex items-center gap-3 text-ui">
            <span>
              Score <strong className="tabular-nums">{percent(model.run.score)}</strong>
            </span>
            {model.run.delta !== null ? <Delta value={model.run.delta} /> : null}
            <Link
              href={suiteHref(model.projectId, model.runId)}
              className="text-accent-fg underline-offset-2 hover:underline"
            >
              The suite table
            </Link>
          </div>
        ) : null
      }
    >
      {model.run?.deltaReason ? (
        <Callout tone="warning" title="No delta for this eval">
          {model.run.deltaReason}
        </Callout>
      ) : null}
      {model.dataset.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No case yet"
          description="Save a trace turn or a sandbox run as an eval case, or make a new case."
        />
      ) : (
        <DataTable
          caption="Cases of the eval"
          columns={datasetColumns(model, scorerNames)}
          rows={model.dataset}
          rowKey={(row) => row.caseId}
          onRowOpen={(row) => router.push(caseHref(model.projectId, row.caseId))}
          className="[&_table]:table-fixed"
        />
      )}
    </Section>
  );
}

function datasetColumns(model: EvalPageModel, scorerNames: string[]): Column<DatasetRow>[] {
  return [
    {
      id: "case",
      header: "Case",
      width: "12rem",
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <Link
            href={caseHref(model.projectId, row.caseId)}
            className="font-medium text-fg hover:underline"
          >
            {row.name}
          </Link>
          <span className="text-xs text-fg-subtle">
            {row.approved ? `v${row.approved}` : "Draft only"}
            {row.approved && row.draft ? ` · draft v${row.draft}` : ""}
          </span>
        </div>
      ),
    },
    { id: "input", header: "Input", cell: (row) => <Clip text={row.input} /> },
    {
      id: "output",
      header: "Output",
      cell: (row) =>
        row.output ? <Clip text={row.output} /> : <span className="text-fg-subtle">—</span>,
    },
    {
      id: "expected",
      header: "Expected",
      hiddenBelow: "lg",
      cell: (row) =>
        row.expectedOutput ? (
          <Clip text={row.expectedOutput} />
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
    ...scorerNames.map(
      (name): Column<DatasetRow> => ({
        id: `scorer:${name}`,
        header: name,
        align: "right",
        width: "7rem",
        hiddenBelow: "md",
        cell: (row) => {
          const cell = row.scorers[name];
          return cell ? (
            <span
              className="tabular-nums"
              title={`${cell.pass} of ${cell.rated} scored trials passed`}
            >
              {percent(cell.passRate)}
            </span>
          ) : (
            <span className="text-fg-subtle">—</span>
          );
        },
      }),
    ),
    {
      id: "change",
      header: "Δ baseline",
      width: "8rem",
      cell: (row) =>
        row.change ? (
          <Badge tone={CHANGE[row.change].tone}>{CHANGE[row.change].label}</Badge>
        ) : null,
    },
    {
      id: "trials",
      header: "Trials",
      width: "9rem",
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.trials.map((trial) => (
            <Link key={trial.id} href={trial.href} aria-label={`Trial ${trial.index + 1}`}>
              <Badge tone={trial.result ? RESULT[trial.result] : "info"}>{trial.index + 1}</Badge>
            </Link>
          ))}
        </div>
      ),
    },
  ];
}

function Clip({ text }: { text: string }) {
  return <span className="line-clamp-2 font-mono text-xs break-all text-fg-muted">{text}</span>;
}
