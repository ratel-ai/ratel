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
import type { CheckOperator } from "@/lib/contracts/check";
import type { EvalScorer } from "@/lib/views/evals/domain/eval";
import type { SaveTarget } from "@/lib/views/evals/domain/eval-target";
import { datasetHref } from "@/lib/views/evals/paths";
import { chosenTargets, type SaveOptions, targetDataset } from "@/lib/views/evals/save-target";

const OPERATORS: Record<CheckOperator, string> = {
  eq: "is",
  ne: "is not",
  contains: "contains",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  exists: "exists",
};

/** A scorer in one line: its name, whether it decides the trial, and what it checks or asks. */
function scorerSentence({ name, gating, definition }: EvalScorer): string {
  const what =
    definition.kind === "judge"
      ? `judge: ${definition.config.prompt}`
      : `${definition.config.path} ${OPERATORS[definition.config.op]} ${definition.config.value ?? ""}`;
  return `${name} (${gating ? "gating" : "advisory"}): ${what.trim()}`;
}

/** What the case is made from: a trace turn, or a sandbox run with the trace it made. */
export type SaveSource =
  | { turnId: string }
  | {
      traceId: string | null;
      name: string;
      content: { input: unknown; expectedOutput: string | null };
    };

const NEW_EVAL = "__new__";

/**
 * "Save as eval case" (decision `trace-to-eval`). The dialog starts from the tasks of the trace:
 * one task, or the task of the page, is chosen first. Else the person chooses one or more, and the
 * turn becomes one row in the dataset of the eval of each. A task with more evals needs the choice
 * of one. A new eval of a task gets the task's default scorers and a dataset of its own, and the
 * person confirms it. With no task, the person chooses or names the eval. The dialog names the
 * dataset that the row joins. The rows count at once.
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
  const [chosenEval, setChosenEval] = useState<string>(NEW_EVAL);
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
      setChosenEval(body.evals[0]?.id ?? NEW_EVAL);
    } catch {
      setProblem("Try again.");
    }
  }

  const targets = options
    ? chosenTargets(options, {
        taskIds,
        evalOfTask,
        ...(chosenEval === NEW_EVAL ? { newName } : { evalId: chosenEval }),
      })
    : null;

  async function save() {
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
        cases?: Array<{ caseId: string; datasetId: string }>;
        message?: string;
      };
      const [only, ...more] = body.cases ?? [];
      if (response.ok && only) {
        if (more.length === 0) {
          toast({
            title: "Saved as a row of the dataset. It counts in the next run.",
            tone: "success",
          });
          return router.push(datasetHref(projectId, only.datasetId));
        }
        toast({
          title: `Saved as ${more.length + 1} rows, one in the dataset of each eval.`,
          tone: "success",
        });
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
          description="The case is a row of the dataset of an eval. It counts in the next run of each eval that uses the dataset."
          footer={
            <>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button variant="primary" onClick={save} loading={pending} disabled={!targets}>
                {isNew ? "Create the eval and save" : "Save the case"}
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
                      options={options}
                      chosenEval={evalOfTask[id] ?? ""}
                      onChoose={(evalId) => setEvalOfTask({ ...evalOfTask, [id]: evalId })}
                    />
                  ) : null;
                })
              ) : (
                <NoTask
                  options={options}
                  evals={options.evals}
                  chosenEval={chosenEval}
                  onChoose={setChosenEval}
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
  options,
  chosenEval,
  onChoose,
}: {
  target: SaveTarget;
  options: SaveOptions;
  chosenEval: string;
  onChoose: (evalId: string) => void;
}) {
  if (target.kind === "existing") {
    return <DatasetLine options={options} evalId={target.evalId} evalName={target.name} />;
  }
  if (target.kind === "choose") {
    const name = target.evals.find(({ id }) => id === chosenEval)?.name ?? null;
    return (
      <>
        <Field label="The task has more evals. Choose the eval of the case.">
          {() => (
            <Select
              aria-label="Eval of the task"
              value={chosenEval}
              placeholder="Choose an eval"
              onValueChange={onChoose}
              options={target.evals.map(({ id, name: one }) => ({ value: id, label: one }))}
            />
          )}
        </Field>
        {name ? <DatasetLine options={options} evalId={chosenEval} evalName={name} /> : null}
      </>
    );
  }
  if (target.kind !== "new") return null;
  const { sandboxName, scorers } = target.content;
  return (
    <div className="flex flex-col gap-2 text-ui">
      <p className="text-fg">
        The task has no eval. Ratel creates the eval <strong>{target.name}</strong>
        {sandboxName ? ` on the sandbox ${sandboxName}` : ""} with a new dataset of its own,{" "}
        <strong>{target.name}</strong>, and the case becomes its first row.
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
  options,
  evals,
  chosenEval,
  onChoose,
  newName,
  onName,
}: {
  options: SaveOptions;
  evals: SaveOptions["evals"];
  chosenEval: string;
  onChoose: (id: string) => void;
  newName: string;
  onName: (name: string) => void;
}) {
  return (
    <>
      <p className="text-ui text-fg-muted">
        No task matched this run. Ratel finds a task in many runs that call the same tools. A run in
        a sandbox gets the task of its sandbox about a minute after its trace arrives. Choose or
        name its eval.
      </p>
      <Field label="Eval">
        {() => (
          <Select
            aria-label="Eval"
            value={chosenEval}
            onValueChange={onChoose}
            options={[
              ...evals.map(({ id, name }) => ({ value: id, label: name })),
              { value: NEW_EVAL, label: "A new eval" },
            ]}
          />
        )}
      </Field>
      {chosenEval !== NEW_EVAL ? (
        <DatasetLine
          options={options}
          evalId={chosenEval}
          evalName={evals.find(({ id }) => id === chosenEval)?.name ?? ""}
        />
      ) : (
        <p className="text-ui text-fg-muted">
          The new eval gets a dataset of its own, with its name, and the case becomes its first row.
        </p>
      )}
      {chosenEval === NEW_EVAL ? (
        <Field label="Name of the new eval">
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

/** The dataset that the row joins, named (decision `trace-to-eval`). */
function DatasetLine({
  options,
  evalId,
  evalName,
}: {
  options: SaveOptions;
  evalId: string;
  evalName: string;
}) {
  const dataset = targetDataset(options, evalId);
  return (
    <p className="text-ui text-fg">
      {dataset ? (
        <>
          The case becomes a row of the dataset <strong>{dataset}</strong>, which the eval{" "}
          <strong>{evalName}</strong> runs.
        </>
      ) : (
        <>
          The case becomes a row of the dataset of the eval <strong>{evalName}</strong>.
        </>
      )}
    </p>
  );
}
