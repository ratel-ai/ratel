"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import {
  checkEvalDraft,
  type DatasetDraft,
  type Errors,
  type EvalDraft,
  emptyEvalDraft,
  runtimeParams,
} from "@/lib/views/evals/eval-form";
import type { DialogData, EditDraft } from "@/lib/views/evals/pages-load";
import { evalHref } from "@/lib/views/evals/paths";
import { sandboxesHref } from "@/lib/views/sandboxes/paths";
import { Choice } from "./Choice";
import { ParamsFields } from "./ParamsFields";
import { QUERY_HELP, type QueryDraft, QueryFields } from "./QueryFields";
import { evalsApi, send } from "./request";
import { ScorerPicker } from "./ScorerPicker";

/** A select cannot hold an empty value: this one stands for "no task". */
const NO_TASK = "__none__";

const DATASET_KINDS = [
  { value: "existing", label: "A dataset", description: "One of the datasets of the project." },
  { value: "last_traces", label: "Last traces", description: QUERY_HELP.last_traces },
  { value: "task_traces", label: "Traces of a task", description: QUERY_HELP.task_traces },
  { value: "rql", label: "RQL query", description: QUERY_HELP.rql },
  { value: "auto", label: "Let Ratel choose", description: QUERY_HELP.auto },
] as const;

/**
 * "New eval", and "Edit" of one eval: a name and an optional task, the runtime (a sandbox, newest
 * ready version or pinned; "Production agent" is coming soon), the dataset (one of the project, or
 * a query made here as a dataset of its own), the params with an optional matrix, the scorers of
 * the library and the trials. An edit adds a version; a started run keeps its own.
 */
export function EvalDialog({
  projectId,
  dialog,
  edit = null,
  open,
  onOpenChange,
}: {
  projectId: string;
  dialog: DialogData;
  /** The eval to edit. Null: a new eval. */
  edit?: EditDraft | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<EvalDraft>(() => initialDraft(dialog, edit));
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const params = runtimeParams(dialog, draft.runtime);
  const sandbox =
    draft.runtime.kind === "sandbox"
      ? dialog.sandboxes.find(
          ({ name }) => name === (draft.runtime as { sandboxName: string }).sandboxName,
        )
      : undefined;

  async function save() {
    const checked = checkEvalDraft(draft, dialog);
    if (!checked.ok) {
      setErrors(checked.errors);
      setProblem("Some fields need a change.");
      return;
    }
    setErrors({});
    setProblem(null);
    setPending(true);
    const answer = edit
      ? await send<{ evalId: string }>("PUT", `${evalsApi(projectId)}/definitions/${edit.evalId}`, {
          ...checked.body,
          base: edit.base,
        })
      : await send<{ evalId: string }>("POST", `${evalsApi(projectId)}/definitions`, checked.body);
    setPending(false);
    if (!answer.ok) return setProblem(answer.message);
    toast({
      title: edit ? "Eval saved. The next run uses it." : `Eval "${checked.body.name}" created.`,
      tone: "success",
    });
    onOpenChange(false);
    if (edit) router.refresh();
    else router.push(evalHref(projectId, answer.data.evalId));
  }

  const datasetKind = draft.dataset.kind;
  const query: QueryDraft | null =
    datasetKind === "existing" ? null : (draft.dataset as QueryDraft);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={edit ? `Edit ${edit.name}` : "New eval"}
        description={
          edit
            ? "A change adds a version of the eval. A run that started keeps its own."
            : "An eval runs a dataset on a runtime and scores each answer."
        }
        className="w-[min(40rem,calc(100vw-2rem))]"
        footer={
          <>
            <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
            <Button variant="primary" onClick={save} loading={pending}>
              {edit ? "Save eval" : "Create eval"}
            </Button>
          </>
        }
      >
        {problem ? (
          <Callout tone="danger" title={edit ? "Not saved" : "Not created"}>
            {problem}
          </Callout>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
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
          <Field label="Task (optional)">
            {(control) => (
              <Select
                id={control.id}
                aria-label="Task"
                value={draft.taskId === "" ? NO_TASK : draft.taskId}
                onValueChange={(taskId) =>
                  setDraft({ ...draft, taskId: taskId === NO_TASK ? "" : taskId })
                }
                options={[
                  { value: NO_TASK, label: "No task" },
                  ...dialog.tasks.map(({ id, name }) => ({ value: id, label: name })),
                ]}
              />
            )}
          </Field>
        </div>
        <Group title="Runtime">
          <Choice
            legend="Runs on"
            name="eval-runtime"
            value={draft.runtime.kind}
            error={errors.runtime}
            onChange={(kind) =>
              setDraft({
                ...draft,
                runtime:
                  kind === "production"
                    ? { kind }
                    : { kind, sandboxName: dialog.sandboxes[0]?.name ?? "", version: "latest" },
              })
            }
            options={[
              {
                value: "sandbox",
                label: "A sandbox",
                description:
                  dialog.sandboxes.length === 0 ? (
                    <>
                      No sandbox has a ready version.{" "}
                      <Link
                        href={sandboxesHref(projectId)}
                        className="text-accent-mark hover:underline"
                      >
                        Open Sandboxes
                      </Link>
                    </>
                  ) : (
                    "Each trial runs in a new instance of the sandbox."
                  ),
              },
              {
                value: "production",
                label: "Production agent",
                description: "Runs against your deployed agent.",
                disabled: true,
                mark: <Badge tone="neutral">Coming soon</Badge>,
              },
            ]}
          />
          {draft.runtime.kind === "sandbox" && dialog.sandboxes.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Sandbox">
                {(control) => (
                  <Select
                    id={control.id}
                    aria-label="Sandbox"
                    value={draft.runtime.kind === "sandbox" ? draft.runtime.sandboxName : ""}
                    onValueChange={(sandboxName) =>
                      setDraft({
                        ...draft,
                        runtime: { kind: "sandbox", sandboxName, version: "latest" },
                        params: {},
                        matrix: {},
                      })
                    }
                    options={dialog.sandboxes.map(({ name }) => ({ value: name, label: name }))}
                  />
                )}
              </Field>
              <Field label="Version">
                {(control) => (
                  <Select
                    id={control.id}
                    aria-label="Version"
                    value={draft.runtime.kind === "sandbox" ? draft.runtime.version : "latest"}
                    onValueChange={(version) =>
                      draft.runtime.kind === "sandbox"
                        ? setDraft({ ...draft, runtime: { ...draft.runtime, version } })
                        : undefined
                    }
                    options={[
                      { value: "latest", label: "Newest ready version" },
                      ...(sandbox?.versions ?? []).map(({ id, label }) => ({
                        value: id,
                        label: `Pinned: ${label}`,
                      })),
                    ]}
                  />
                )}
              </Field>
            </div>
          ) : null}
        </Group>
        <Group title="Dataset">
          <Choice
            legend="Rows from"
            name="eval-dataset"
            value={datasetKind}
            error={datasetKind === "existing" ? errors.dataset : undefined}
            onChange={(kind) =>
              setDraft({ ...draft, dataset: datasetDraftOf(kind, draft.dataset, dialog) })
            }
            options={DATASET_KINDS}
          />
          {draft.dataset.kind === "existing" ? (
            <Field
              label="Dataset"
              description={
                dialog.datasets.length === 0 ? "The project has no dataset yet." : undefined
              }
            >
              {(control) => (
                <Select
                  id={control.id}
                  aria-label="Dataset"
                  value={draft.dataset.kind === "existing" ? draft.dataset.datasetId : ""}
                  placeholder="Choose a dataset"
                  onValueChange={(datasetId) =>
                    setDraft({ ...draft, dataset: { kind: "existing", datasetId } })
                  }
                  options={dialog.datasets.map(({ id, name, kindLabel }) => ({
                    value: id,
                    label: `${name} · ${kindLabel}`,
                  }))}
                />
              )}
            </Field>
          ) : null}
          {query ? (
            <>
              <p className="text-xs text-fg-subtle">
                The query becomes a dataset named after the eval. Each run reads it again and
                freezes the rows that it finds.
              </p>
              <QueryFields
                projectId={projectId}
                draft={query}
                onChange={(next) => setDraft({ ...draft, dataset: next })}
                tasks={dialog.tasks}
                errors={errors}
              />
            </>
          ) : null}
        </Group>
        {params.length > 0 ? (
          <Group title="Parameters">
            <ParamsFields
              params={params}
              values={draft.params}
              onValues={(values) => setDraft({ ...draft, params: values })}
              matrixOn={draft.matrixOn}
              onMatrixOn={(matrixOn) => setDraft({ ...draft, matrixOn })}
              matrix={draft.matrix}
              onMatrix={(matrix) => setDraft({ ...draft, matrix })}
              errors={errors}
            />
          </Group>
        ) : null}
        <Group title="Scoring">
          {edit && edit.keptScorers.length > 0 ? (
            <p className="text-xs text-fg-subtle">
              This eval holds scorers of its own ({edit.keptScorers.join(", ")}). A save keeps only
              the library scorers below.
            </p>
          ) : null}
          <ScorerPicker
            projectId={projectId}
            library={dialog.library}
            picks={draft.scorers}
            onChange={(scorers) => setDraft({ ...draft, scorers })}
            errors={errors}
          />
          <Field
            label="Trials of each row"
            description="From 1 to 20. Each trial is one run of the agent."
            error={errors.trials}
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                max={20}
                className="w-28"
                value={draft.trials}
                onChange={(event) => setDraft({ ...draft, trials: event.target.value })}
              />
            )}
          </Field>
        </Group>
      </DialogContent>
    </Dialog>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-3">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children}
    </section>
  );
}

function datasetDraftOf(
  kind: DatasetDraft["kind"],
  current: DatasetDraft,
  dialog: DialogData,
): DatasetDraft {
  const limit = "limit" in current ? current.limit : "50";
  switch (kind) {
    case "existing":
      return { kind, datasetId: dialog.datasets[0]?.id ?? "" };
    case "last_traces":
      return { kind, limit };
    case "task_traces":
      return { kind, taskId: dialog.tasks[0]?.id ?? "", limit };
    case "rql":
      return { kind, text: "", limit };
    case "auto":
      return { kind, taskId: "", limit };
  }
}

function initialDraft(dialog: DialogData, edit: EditDraft | null): EvalDraft {
  const empty = emptyEvalDraft(dialog, dialog.datasets[0]?.id ?? null);
  if (!edit) return empty;
  const matrixOn = Object.keys(edit.matrix).length > 0;
  return {
    name: edit.name,
    taskId: edit.taskId,
    runtime: edit.sandboxName
      ? { kind: "sandbox", sandboxName: edit.sandboxName, version: edit.versionId ?? "latest" }
      : empty.runtime,
    dataset: { kind: "existing", datasetId: edit.datasetId },
    params: Object.fromEntries(
      Object.entries(edit.params).map(([key, value]) => [
        key,
        typeof value === "boolean" ? value : String(value ?? ""),
      ]),
    ),
    matrixOn,
    matrix: Object.fromEntries(
      Object.entries(edit.matrix).map(([key, values]) => [key, values.map(String).join(", ")]),
    ),
    scorers: edit.scorers,
    trials: String(edit.trials),
  };
}
