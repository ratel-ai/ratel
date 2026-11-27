"use client";

import { Button } from "@ratel/design-system/button";
import { Checkbox } from "@ratel/design-system/checkbox";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SaveTarget } from "@/lib/views/evals/domain/eval-target";
import { caseHref, datasetHref } from "@/lib/views/evals/paths";
import {
  chosenDataset,
  chosenTargets,
  type SaveOptions,
  targetDataset,
} from "@/lib/views/evals/save-target";
import { scorerSentence } from "./ScorerFields";

/** What the case is made from: a trace turn, or a sandbox run with the trace it made. */
export type SaveSource =
  | { turnId: string }
  | {
      traceId: string | null;
      name: string;
      content: { input: unknown; expectedOutput: string | null };
    };

const NEW_DATASET = "__new__";

/**
 * "Save as eval case" (decision `trace-to-eval`). The dialog starts from the tasks of the trace:
 * one task, or the task of the page, is chosen first. Else the person chooses one or more, and the
 * turn becomes one row in the eval of each. A task with more evals needs the choice of one. A new
 * eval of a task gets the task's default scorers and a new fixed dataset, and the person confirms
 * it. Each target names the dataset that the row goes into. With no task, the person chooses a
 * fixed dataset or names a new one. The rows count at once.
 */
export function SaveAsEvalCase({
  projectId,
  source,
  pageTaskId = null,
  label = "Save as eval case",
}: {
  projectId: string;
  source: SaveSource;
  pageTaskId?: string | null;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<SaveOptions | null>(null);
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [evalOfTask, setEvalOfTask] = useState<Record<string, string>>({});
  const [chosenDatasetId, setChosenDatasetId] = useState<string>(NEW_DATASET);
  const [newName, setNewName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function start() {
    setOpen(true);
    setProblem(null);
    const query = new URLSearchParams();
    if ("turnId" in source) query.set("turnId", source.turnId);
    else if (source.traceId) query.set("traceId", source.traceId);
    if (pageTaskId) query.set("task", pageTaskId);
    try {
      const response = await fetch(`/api/projects/${projectId}/evals/save-target?${query}`);
      const body = (await response.json()) as SaveOptions & { message?: string };
      if (!response.ok) return setProblem(body.message ?? "Try again.");
      setOptions(body);
      setTaskIds(body.defaultTaskId ? [body.defaultTaskId] : []);
      setEvalOfTask({});
      setChosenDatasetId(body.datasets[0]?.id ?? NEW_DATASET);
    } catch {
      setProblem("Try again.");
    }
  }

  const noTask = options !== null && options.tasks.length === 0;
  const targets = options && !noTask ? chosenTargets(options, { taskIds, evalOfTask }) : null;
  const dataset =
    options && noTask
      ? chosenDataset(
          options,
          chosenDatasetId === NEW_DATASET ? { newName } : { datasetId: chosenDatasetId },
        )
      : null;

  async function save() {
    if (dataset) return saveToDataset(dataset);
    if (!targets) return;
    setPending(true);
    setProblem(null);
    const content =
      "turnId" in source
        ? { turnId: source.turnId }
        : { name: source.name, labels: [], content: source.content };
    try {
      const response = await fetch(`/api/projects/${projectId}/evals/cases`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...content, targets }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        cases?: Array<{ caseId: string }>;
        message?: string;
      };
      const [only, ...more] = body.cases ?? [];
      if (response.ok && only) {
        if (more.length === 0) {
          toast({ title: "Saved as a case. It counts in the next run.", tone: "success" });
          return router.push(caseHref(projectId, only.caseId));
        }
        toast({ title: `Saved as ${more.length + 1} cases, one in each eval.`, tone: "success" });
        setOpen(false);
        setPending(false);
        return router.refresh();
      }
      setProblem(body.message ?? "Try again.");
    } catch {
      setProblem("Try again.");
    }
    setPending(false);
  }

  /** With no task: one row in the fixed dataset that the person chose, or in a new one. */
  async function saveToDataset(target: NonNullable<typeof dataset>) {
    setPending(true);
    setProblem(null);
    const row =
      "turnId" in source
        ? { turnIds: [source.turnId] }
        : { case: { name: source.name, content: source.content } };
    const base = `/api/projects/${projectId}/evals/datasets`;
    try {
      const response = await fetch(
        "datasetId" in target ? `${base}/${target.datasetId}/rows` : base,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify("datasetId" in target ? row : { name: target.newName, ...row }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        dataset?: { datasetId: string };
        message?: string;
      };
      const datasetId = "datasetId" in target ? target.datasetId : body.dataset?.datasetId;
      if (response.ok && datasetId) {
        const name = "datasetId" in target ? target.name : target.newName;
        toast({
          title: `Saved in the dataset ${name}. It counts in the next run.`,
          tone: "success",
        });
        return router.push(datasetHref(projectId, datasetId));
      }
      setProblem(body.message ?? "Try again.");
    } catch {
      setProblem("Try again.");
    }
    setPending(false);
  }

  const isNew = options && taskIds.some((id) => options.targets[id]?.kind === "new");
  const toggle = (id: string, on: boolean) =>
    setTaskIds((ids) => (on ? [...ids, id] : ids.filter((one) => one !== id)));
  return (
    <>
      <Button size="sm" variant="secondary" onClick={start}>
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Save as eval case"
          description="The case is a row of a dataset. It counts in the next run of each eval that uses the dataset."
          footer={
            <>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button
                variant="primary"
                onClick={save}
                loading={pending}
                disabled={!targets && !dataset}
              >
                {isNew
                  ? "Create the eval and save"
                  : noTask && chosenDatasetId === NEW_DATASET
                    ? "Create the dataset and save"
                    : "Save the case"}
              </Button>
            </>
          }
        >
          {problem ? (
            <Callout tone="danger" title="Not saved">
              {problem}
            </Callout>
          ) : null}
          {!options ? (
            problem ? null : (
              <p className="text-ui text-fg-muted">Reading the tasks…</p>
            )
          ) : (
            <div className="flex flex-col gap-3">
              {options.tasks.length > 1 ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-ui text-fg-muted">
                    The trace has more tasks. Choose one or more: each gets one row.
                  </legend>
                  {options.tasks.map(({ id, name }) => (
                    <Checkbox
                      key={id}
                      name="save-task"
                      checked={taskIds.includes(id)}
                      onCheckedChange={(on) => toggle(id, on)}
                      label={name}
                    />
                  ))}
                </fieldset>
              ) : null}
              {options.tasks.length > 0 ? (
                taskIds.map((id) => {
                  const target = options.targets[id];
                  return target ? (
                    <TargetLine
                      key={id}
                      target={target}
                      datasetName={targetDataset(options, target, evalOfTask[id])}
                      chosenEval={evalOfTask[id] ?? ""}
                      onChoose={(evalId) => setEvalOfTask({ ...evalOfTask, [id]: evalId })}
                    />
                  ) : null;
                })
              ) : (
                <NoTask
                  datasets={options.datasets}
                  chosenDataset={chosenDatasetId}
                  onChoose={setChosenDatasetId}
                  newName={newName}
                  onName={setNewName}
                />
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The target eval of a task, in words. With more evals, the person chooses one. A new eval shows
 * what it gets, so the person can confirm it.
 */
function TargetLine({
  target,
  datasetName,
  chosenEval,
  onChoose,
}: {
  target: SaveTarget;
  /** The dataset that the row goes into. Null until the person chooses the eval. */
  datasetName: string | null;
  chosenEval: string;
  onChoose: (evalId: string) => void;
}) {
  if (target.kind === "existing") {
    return (
      <p className="text-ui text-fg">
        The case goes into the dataset <strong>{datasetName ?? target.name}</strong> of the eval{" "}
        <strong>{target.name}</strong>.
      </p>
    );
  }
  if (target.kind === "choose") {
    return (
      <Field
        label="The task has more evals. Choose the eval of the case."
        description={datasetName ? `The case goes into the dataset ${datasetName}.` : undefined}
      >
        {() => (
          <Select
            aria-label="Eval of the task"
            value={chosenEval}
            placeholder="Choose an eval"
            onValueChange={onChoose}
            options={target.evals.map(({ id, name }) => ({ value: id, label: name }))}
          />
        )}
      </Field>
    );
  }
  if (target.kind !== "new") return null;
  const { sandboxName, scorers } = target.content;
  return (
    <div className="flex flex-col gap-2 text-ui">
      <p className="text-fg">
        The task has no eval. Ratel creates the eval <strong>{target.name}</strong>
        {sandboxName ? ` on the sandbox ${sandboxName}` : ""} with a new dataset{" "}
        <strong>{datasetName ?? target.name}</strong>, and the case goes into that dataset.
      </p>
      {scorers.length > 0 ? (
        <ul className="list-disc pl-5 text-fg-muted">
          {scorers.map((scorer) => (
            <li key={scorer.id}>{scorerSentence(scorer)}</li>
          ))}
        </ul>
      ) : (
        <p className="text-fg-muted">The task has no default scorer. Add scorers to the eval.</p>
      )}
    </div>
  );
}

function NoTask({
  datasets,
  chosenDataset: chosen,
  onChoose,
  newName,
  onName,
}: {
  datasets: SaveOptions["datasets"];
  chosenDataset: string;
  onChoose: (id: string) => void;
  newName: string;
  onName: (name: string) => void;
}) {
  return (
    <>
      <p className="text-ui text-fg-muted">
        No task matched this run. Ratel finds a task in many runs that call the same tools. A run on
        a sandbox gets the task of its sandbox about a minute after its trace arrives. Choose or
        name the dataset of the case.
      </p>
      <Field label="Dataset">
        {() => (
          <Select
            aria-label="Dataset"
            value={chosen}
            onValueChange={onChoose}
            options={[
              ...datasets.map(({ id, name }) => ({ value: id, label: name })),
              { value: NEW_DATASET, label: "A new dataset" },
            ]}
          />
        )}
      </Field>
      {chosen === NEW_DATASET ? (
        <Field label="Name of the new dataset">
          {(control) => (
            <Input
              {...control}
              value={newName}
              maxLength={100}
              onChange={(event) => onName(event.target.value)}
            />
          )}
        </Field>
      ) : null}
    </>
  );
}
