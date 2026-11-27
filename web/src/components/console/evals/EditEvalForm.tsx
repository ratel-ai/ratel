"use client";

import { Button } from "@ratel/design-system/button";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { EvalScorer } from "@/lib/views/evals/domain/eval";
import { evalHref, evalsHref } from "@/lib/views/evals/paths";
import { ScorerFields } from "./ScorerFields";

/** What the editor of an eval reads: its newest version, the base of the next one. */
export type EditableEval = {
  projectId: string;
  id: string;
  name: string;
  taskId: string | null;
  version: {
    id: string;
    number: number;
    sandboxName: string | null;
    params: Record<string, unknown>;
    trials: number;
    scorers: EvalScorer[];
  };
};

/**
 * "Edit" of an eval: its name, task, sandbox, default params, trials and scorers. A save with
 * other content adds a version, so a run that started keeps the version that it froze.
 */
export function EditEvalForm({ model, canEdit }: { model: EditableEval; canEdit: boolean }) {
  return (
    <Page>
      <PageHeader
        title={`Edit ${model.name}`}
        crumbs={[
          { label: "Evals", href: evalsHref(model.projectId) },
          { label: model.name, href: evalHref(model.projectId, model.id) },
        ]}
      />
      <PageBody>
        <DefinitionForm model={model} canEdit={canEdit} />
      </PageBody>
    </Page>
  );
}

function DefinitionForm({ model, canEdit }: { model: EditableEval; canEdit: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(model.name);
  const [taskId, setTaskId] = useState(model.taskId ?? "");
  const [sandboxName, setSandboxName] = useState(model.version.sandboxName ?? "");
  const [params, setParams] = useState(JSON.stringify(model.version.params, null, 2));
  const [trials, setTrials] = useState(String(model.version.trials));
  const [scorers, setScorers] = useState<EvalScorer[]>(model.version.scorers);
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
      base: model.version.id,
    };
    try {
      const response = await fetch(`${base}/${model.id}`, {
        method: "PUT",
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
        router.push(evalHref(model.projectId, model.id));
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
      description={`Version ${model.version.number}. A save with other content makes a new version: a run keeps the version that it started with.`}
      actions={
        canEdit ? (
          <Button variant="primary" onClick={save} loading={pending}>
            Save the eval
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
