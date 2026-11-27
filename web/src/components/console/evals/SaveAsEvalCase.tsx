"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SaveTarget } from "@/lib/views/evals/domain/eval-target";
import { caseHref } from "@/lib/views/evals/paths";
import type { SaveOptions } from "@/lib/views/evals/save-target";
import { scorerSentence } from "./ScorerFields";

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
 * "Save as eval case" (decision `trace-to-eval`). The dialog shows the target eval first: the eval
 * of the task, a choice of task when there are more, or an eval to name when there is none. A new
 * eval of a task gets the task's default scorers, and the person confirms it. The row is a draft.
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
  const [taskId, setTaskId] = useState<string | null>(null);
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
      setTaskId(body.defaultTaskId);
      setChosenEval(body.evals[0]?.id ?? NEW_EVAL);
    } catch {
      setProblem("Try again.");
    }
  }

  const target = targetOf(options, taskId, chosenEval, newName);

  async function save() {
    if (!target) return;
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
        body: JSON.stringify({ ...content, ...target }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        caseId?: string;
        message?: string;
      };
      if (response.ok && body.caseId) {
        toast({ title: "Saved as a draft case", tone: "success" });
        return router.push(caseHref(projectId, body.caseId));
      }
      setProblem(body.message ?? "Try again.");
    } catch {
      setProblem("Try again.");
    }
    setPending(false);
  }

  const chosen = options && taskId ? options.targets[taskId] : null;
  return (
    <>
      <Button size="sm" variant="secondary" onClick={start}>
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Save as eval case"
          description="The case is a draft row of the dataset of an eval. Approve it to make it count."
          footer={
            <>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button variant="primary" onClick={save} loading={pending} disabled={!target}>
                {chosen?.kind === "new" ? "Create the eval and save" : "Save the case"}
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
                <Field label="Task">
                  {() => (
                    <Select
                      aria-label="Task"
                      value={taskId ?? ""}
                      placeholder="Choose a task"
                      onValueChange={setTaskId}
                      options={options.tasks.map(({ id, name }) => ({ value: id, label: name }))}
                    />
                  )}
                </Field>
              ) : null}
              {chosen ? (
                <TargetLine target={chosen} />
              ) : options.tasks.length > 1 ? (
                <p className="text-ui text-fg-muted">Choose the task of the case.</p>
              ) : (
                <NoTask
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

/** The target eval, in words. A new eval shows what it gets, so the person can confirm it. */
function TargetLine({ target }: { target: SaveTarget }) {
  if (target.kind === "existing") {
    return (
      <p className="text-ui text-fg">
        The case goes into the eval <strong>{target.name}</strong>.
      </p>
    );
  }
  if (target.kind !== "new") return null;
  const { sandboxName, scorers } = target.content;
  return (
    <div className="flex flex-col gap-2 text-ui">
      <p className="text-fg">
        The task has no eval. Ratel creates the eval <strong>{target.name}</strong>
        {sandboxName ? ` on the sandbox ${sandboxName}` : ""}, and the case goes into it.
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
  evals,
  chosenEval,
  onChoose,
  newName,
  onName,
}: {
  evals: SaveOptions["evals"];
  chosenEval: string;
  onChoose: (id: string) => void;
  newName: string;
  onName: (name: string) => void;
}) {
  return (
    <>
      <p className="text-ui text-fg-muted">No task matched this run. Choose or name its eval.</p>
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

/** The `evalId` or the `newEval` of the request. Null until the person chose. */
function targetOf(
  options: SaveOptions | null,
  taskId: string | null,
  chosenEval: string,
  newName: string,
): { evalId: string } | { newEval: object } | null {
  if (!options) return null;
  const target = taskId ? options.targets[taskId] : null;
  if (target?.kind === "existing") return { evalId: target.evalId };
  if (target?.kind === "new") {
    const { name, taskId: task, content } = target;
    return { newEval: { name, taskId: task, content } };
  }
  if (options.tasks.length > 1) return null;
  if (chosenEval !== NEW_EVAL) return { evalId: chosenEval };
  const name = newName.trim();
  return name ? { newEval: { name, taskId: null } } : null;
}
