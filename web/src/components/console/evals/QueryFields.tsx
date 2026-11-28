"use client";

import { Button } from "@ratel/design-system/button";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { useState } from "react";
import type { PreviewResult } from "@/lib/views/evals/datasets";
import type { DatasetQuery } from "@/lib/views/evals/domain/dataset";
import { checkDataset, type DatasetDraft, type Errors } from "@/lib/views/evals/eval-form";
import { evalsApi, send } from "./request";

/** A select cannot hold an empty value: this one stands for "any task". */
const ANY_TASK = "__any__";

export type QueryDraft = Exclude<DatasetDraft, { kind: "existing" }>;

/** What each query kind reads, in one line. */
export const QUERY_HELP: Record<QueryDraft["kind"], string> = {
  last_traces: "The newest closed traces of the project.",
  task_traces: "The newest closed traces of one task.",
  rql: "The traces that an RQL query gives in its trace_id column.",
  auto: "Failed traces first, then one trace of each task in turn. With a task, the selection of that task.",
};

/**
 * The settings of a query kind: how many traces, the task, the RQL text. "Preview" shows what the
 * query reads now; a run reads it again and freezes the rows that it finds.
 */
export function QueryFields({
  projectId,
  draft,
  onChange,
  tasks,
  errors,
}: {
  projectId: string;
  draft: QueryDraft;
  onChange: (draft: QueryDraft) => void;
  tasks: ReadonlyArray<{ id: string; name: string }>;
  errors: Errors;
}) {
  const taskOptions = tasks.map(({ id, name }) => ({ value: id, label: name }));
  return (
    <div className="flex flex-col gap-3">
      {draft.kind === "rql" ? (
        <Field
          label="RQL query"
          description="One SELECT that gives a trace_id column."
          error={errors.dataset}
        >
          {(control) => (
            <Textarea
              {...control}
              rows={4}
              spellCheck={false}
              className="font-mono text-xs"
              placeholder="SELECT trace_id FROM traces WHERE status = 'error' LIMIT 20"
              value={draft.text}
              onChange={(event) => onChange({ ...draft, text: event.target.value })}
            />
          )}
        </Field>
      ) : null}
      {draft.kind === "task_traces" || draft.kind === "auto" ? (
        <Field
          label={draft.kind === "auto" ? "Task (optional)" : "Task"}
          error={draft.kind === "task_traces" ? errors.dataset : undefined}
          description={tasks.length === 0 ? "The project has no task yet." : undefined}
        >
          {(control) => (
            <Select
              id={control.id}
              aria-label="Task"
              value={draft.kind === "auto" && draft.taskId === "" ? ANY_TASK : draft.taskId}
              placeholder="Choose a task"
              onValueChange={(taskId) =>
                onChange({ ...draft, taskId: taskId === ANY_TASK ? "" : taskId })
              }
              options={
                draft.kind === "auto"
                  ? [{ value: ANY_TASK, label: "Any task" }, ...taskOptions]
                  : taskOptions
              }
            />
          )}
        </Field>
      ) : null}
      <Field label="Traces, at most" description="From 1 to 500." error={errors.limit}>
        {(control) => (
          <Input
            {...control}
            type="number"
            min={1}
            max={500}
            className="w-28"
            value={draft.limit}
            onChange={(event) => onChange({ ...draft, limit: event.target.value })}
          />
        )}
      </Field>
      <QueryPreview projectId={projectId} draft={draft} />
    </div>
  );
}

/** What a query reads now: the turns it finds and the first rows. Nothing is frozen. */
export function QueryPreview({ projectId, draft }: { projectId: string; draft: QueryDraft }) {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function load() {
    const errors: Errors = {};
    const made = checkDataset(draft, errors);
    if (!made || !("query" in made)) {
      setProblem(Object.values(errors)[0] ?? "Fill in the query first.");
      return;
    }
    setPending(true);
    setProblem(null);
    const answer = await send<PreviewResult>("POST", `${evalsApi(projectId)}/datasets/preview`, {
      query: made.query satisfies DatasetQuery,
    });
    setPending(false);
    if (answer.ok) setPreview(answer.data);
    else setProblem(answer.message);
  }
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button size="sm" onClick={load} loading={pending}>
          Preview
        </Button>
      </div>
      {problem ? <Callout tone="danger">{problem}</Callout> : null}
      {preview ? <PreviewRows preview={preview} /> : null}
    </div>
  );
}

export function PreviewRows({ preview }: { preview: PreviewResult }) {
  if (!preview.ok) {
    return (
      <Callout tone="warning" title="A run would refuse this query now">
        {preview.message}
      </Callout>
    );
  }
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <p className="text-xs text-fg-subtle">
        It finds {preview.found} {preview.found === 1 ? "trace" : "traces"} now. A run freezes the
        rows that it finds when it starts. The first rows:
      </p>
      <ul className="flex flex-col rounded-md border border-line">
        {preview.rows.map((row) => (
          <li
            key={row.turnId}
            className="truncate border-b border-line px-3 py-1.5 font-mono text-xs text-fg-muted last:border-b-0"
            title={row.input ?? undefined}
          >
            {row.input ?? `Turn ${row.turnId.slice(0, 8)}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
