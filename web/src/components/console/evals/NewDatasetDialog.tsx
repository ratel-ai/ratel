"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  checkDatasetDraft,
  type Errors,
  emptyDatasetDraft,
  type NewDatasetDraft,
  queryDraftOf,
} from "@/lib/views/evals/eval-form";
import { datasetHref } from "@/lib/views/evals/paths";
import { Choice } from "./Choice";
import { QUERY_HELP, type QueryDraft, QueryFields } from "./QueryFields";
import { evalsApi, send } from "./request";
import { TracePicker } from "./TracePicker";

const KINDS = [
  {
    value: "fixed",
    label: "Fixed rows",
    description: "Rows that you add: empty, or from traces that you choose.",
  },
  { value: "last_traces", label: "Last traces", description: QUERY_HELP.last_traces },
  { value: "task_traces", label: "Traces of a task", description: QUERY_HELP.task_traces },
  { value: "rql", label: "RQL query", description: QUERY_HELP.rql },
  { value: "auto", label: "Let Ratel choose", description: QUERY_HELP.auto },
] as const;

/** "New dataset": a dataset of one kind. A query kind is read again by each run. */
export function NewDatasetDialog({
  projectId,
  tasks,
}: {
  projectId: string;
  tasks: ReadonlyArray<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<NewDatasetDraft>(emptyDatasetDraft);
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const query = queryDraftOf(draft);

  function onQuery(next: QueryDraft) {
    setDraft({
      ...draft,
      limit: next.limit,
      ...("taskId" in next ? { taskId: next.taskId } : {}),
      ...("text" in next ? { text: next.text } : {}),
    });
  }

  async function create() {
    const checked = checkDatasetDraft(draft);
    if (!checked.ok) return setErrors(checked.errors);
    setErrors({});
    setPending(true);
    setProblem(null);
    const answer = await send<{ datasetId: string; rows: number }>(
      "POST",
      `${evalsApi(projectId)}/datasets`,
      checked.body,
    );
    setPending(false);
    if (!answer.ok) return setProblem(answer.message);
    toast({ title: `Dataset "${checked.body.name}" created.`, tone: "success" });
    setOpen(false);
    setDraft(emptyDatasetDraft());
    router.push(datasetHref(projectId, answer.data.datasetId));
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        New dataset
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="New dataset"
          description="A set of inputs that evals run. A run freezes the rows that it reads."
          className="w-[min(36rem,calc(100vw-2rem))]"
          footer={
            <>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button variant="primary" onClick={create} loading={pending}>
                Create dataset
              </Button>
            </>
          }
        >
          {problem ? (
            <Callout tone="danger" title="Not created">
              {problem}
            </Callout>
          ) : null}
          <Field label="Name" error={errors.name}>
            {(control) => (
              <Input
                {...control}
                value={draft.name}
                maxLength={100}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            )}
          </Field>
          <Choice
            legend="Kind"
            name="dataset-kind"
            value={draft.kind}
            options={KINDS}
            onChange={(kind) => setDraft({ ...draft, kind })}
          />
          {query ? (
            <QueryFields
              projectId={projectId}
              draft={query}
              onChange={onQuery}
              tasks={tasks}
              errors={errors}
            />
          ) : (
            <TracePicker
              projectId={projectId}
              tasks={tasks}
              chosen={draft.turnIds}
              onChange={(turnIds) => setDraft({ ...draft, turnIds })}
            />
          )}
          {errors.rows ? <p className="text-xs text-danger">{errors.rows}</p> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
