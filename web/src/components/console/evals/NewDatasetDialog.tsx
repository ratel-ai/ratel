"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PickerOptions } from "@/lib/views/evals/adapters/turn-picker";
import {
  type DatasetDraft,
  draftQuery,
  FREEZE_NOTE,
  KIND_HELP,
  KIND_LABELS,
} from "@/lib/views/evals/dataset-pages";
import {
  DATASET_KINDS,
  type DatasetKind,
  DEFAULT_ROW_LIMIT,
} from "@/lib/views/evals/domain/dataset";
import { datasetHref } from "@/lib/views/evals/paths";
import { QueryPreview, TurnPicker } from "./DatasetPickers";

const KIND_OPTIONS = DATASET_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] }));
const ANY_TASK = "";
const EMPTY: DatasetDraft = {
  kind: "fixed",
  limit: String(DEFAULT_ROW_LIMIT),
  taskId: "",
  rql: "",
};

/**
 * "New dataset": a name, a description and one kind. A fixed dataset starts empty or with chosen
 * traces. A query kind keeps its query, and a run resolves it and freezes its rows.
 */
export function NewDatasetDialog({
  projectId,
  options,
  now,
}: {
  projectId: string;
  options: PickerOptions;
  now: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<DatasetDraft>(EMPTY);
  const [turnIds, setTurnIds] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const made = draftQuery(draft);
  const set = (over: Partial<DatasetDraft>) => setDraft((was) => ({ ...was, ...over }));

  function reset(next: boolean) {
    setOpen(next);
    if (next) return;
    setName("");
    setDescription("");
    setDraft(EMPTY);
    setTurnIds([]);
    setProblem(null);
  }

  async function create() {
    if (!made.ok) return setProblem(made.message);
    setSaving(true);
    setProblem(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/evals/datasets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description: description.trim() || null,
          query: made.query,
          ...(draft.kind === "fixed" && turnIds.length > 0 ? { turnIds } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        dataset?: { datasetId: string };
        message?: string;
      };
      if (!response.ok || !body.dataset) return setProblem(body.message ?? "Try again.");
      toast({ title: `Dataset ${name.trim()} created`, tone: "success" });
      reset(false);
      router.push(datasetHref(projectId, body.dataset.datasetId));
    } catch {
      setProblem("Try again.");
    } finally {
      setSaving(false);
    }
  }

  const taskOptions = options.tasks.map(({ id, name: label }) => ({ value: id, label }));
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        New dataset
      </Button>
      <Dialog open={open} onOpenChange={reset}>
        <DialogContent
          title="New dataset"
          description="A set of inputs for evals. Several evals can use one dataset."
          className="max-w-2xl"
          footer={
            <>
              <DialogClose render={<Button />}>Cancel</DialogClose>
              <Button
                variant="primary"
                onClick={create}
                disabled={saving || !name.trim() || !made.ok}
              >
                {saving ? "Creating…" : "Create dataset"}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <Field label="Name">
              {(control) => (
                <Input
                  {...control}
                  value={name}
                  maxLength={100}
                  onChange={(event) => setName(event.currentTarget.value)}
                  placeholder="Refund asks"
                />
              )}
            </Field>
            <Field label="Description" description="Optional.">
              {(control) => (
                <Input
                  {...control}
                  value={description}
                  maxLength={2000}
                  onChange={(event) => setDescription(event.currentTarget.value)}
                />
              )}
            </Field>
            <Field label="Kind" description={KIND_HELP[draft.kind]}>
              {(control) => (
                <Select
                  id={control.id}
                  aria-label="Kind"
                  options={KIND_OPTIONS}
                  value={draft.kind}
                  onValueChange={(kind) => set({ kind: kind as DatasetKind })}
                />
              )}
            </Field>
            <KindFields
              projectId={projectId}
              draft={draft}
              set={set}
              taskOptions={taskOptions}
              options={options}
              turnIds={turnIds}
              setTurnIds={setTurnIds}
              now={now}
              query={made.ok ? made.query : null}
            />
            {problem ? (
              <Callout tone="danger" title="The dataset was not created">
                {problem}
              </Callout>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The fields of the chosen kind. */
function KindFields({
  projectId,
  draft,
  set,
  taskOptions,
  options,
  turnIds,
  setTurnIds,
  now,
  query,
}: {
  projectId: string;
  draft: DatasetDraft;
  set: (over: Partial<DatasetDraft>) => void;
  taskOptions: Array<{ value: string; label: string }>;
  options: PickerOptions;
  turnIds: string[];
  setTurnIds: (ids: string[]) => void;
  now: string;
  query: Parameters<typeof QueryPreview>[0]["query"];
}) {
  if (draft.kind === "fixed") {
    return (
      <Field
        label="Traces"
        description={
          turnIds.length === 0
            ? "Optional. Choose traces now, or add rows on the dataset page."
            : `${turnIds.length} chosen. Each becomes a row with its input.`
        }
      >
        {() => (
          <TurnPicker
            projectId={projectId}
            turns={options.turns}
            chosen={turnIds}
            onChange={setTurnIds}
            now={now}
          />
        )}
      </Field>
    );
  }
  return (
    <>
      {draft.kind === "task_traces" || draft.kind === "auto" ? (
        <Field
          label="Task"
          description={
            draft.kind === "auto" ? "Optional. Keep to the traces of one task." : undefined
          }
        >
          {(control) => (
            <Select
              id={control.id}
              aria-label="Task"
              options={
                draft.kind === "auto"
                  ? [{ value: ANY_TASK, label: "Each task" }, ...taskOptions]
                  : taskOptions
              }
              value={draft.taskId}
              placeholder={taskOptions.length === 0 ? "No task yet" : "Choose a task"}
              disabled={taskOptions.length === 0}
              onValueChange={(taskId) => set({ taskId })}
            />
          )}
        </Field>
      ) : null}
      {draft.kind === "rql" ? (
        <Field label="RQL query" description="One SELECT that gives a trace_id column.">
          {(control) => (
            <Textarea
              {...control}
              rows={4}
              className="font-mono text-xs"
              value={draft.rql}
              onChange={(event) => set({ rql: event.currentTarget.value })}
              placeholder="select trace_id from traces where has_error limit 20"
            />
          )}
        </Field>
      ) : null}
      <Field label="Traces" description="The most rows that a run resolves, from 1 to 500.">
        {(control) => (
          <Input
            {...control}
            type="number"
            min={1}
            max={500}
            className="w-28"
            value={draft.limit}
            onChange={(event) => set({ limit: event.currentTarget.value })}
          />
        )}
      </Field>
      <p className="text-xs text-fg-subtle">{FREEZE_NOTE}</p>
      {/* A new query starts a new preview: an old one would show rows of another query. */}
      <QueryPreview key={JSON.stringify(query)} projectId={projectId} query={query} />
    </>
  );
}
