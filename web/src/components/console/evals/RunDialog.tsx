"use client";

import { Button } from "@ratel/design-system/button";
import { Switch } from "@ratel/design-system/checkbox";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import {
  type AddRowsDraft,
  checkRunDraft,
  type Errors,
  type RunDefaults,
  type RunDraft,
  runDraftOf,
  runtimeParams,
} from "@/lib/views/evals/eval-form";
import type { DialogData } from "@/lib/views/evals/pages-load";
import { Choice } from "./Choice";
import { ParamsFields } from "./ParamsFields";
import { evalsApi, send } from "./request";
import { ScorerPicker } from "./ScorerPicker";
import { TracePicker } from "./TracePicker";

/**
 * "New run": the defaults of the eval, each one open to a change for this run only: the dataset,
 * rows added from traces (chosen, the last N, or Ratel's choice), the scorers, a pinned runtime
 * version, the params or a matrix, the trials. The run records what it changed.
 */
export function RunDialog({
  projectId,
  evalId,
  evalName,
  defaults,
  dialog,
  open,
  onOpenChange,
}: {
  projectId: string;
  evalId: string;
  evalName: string;
  defaults: RunDefaults;
  dialog: DialogData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<RunDraft>(() => runDraftOf(defaults));
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const sandbox = dialog.sandboxes.find(({ name }) => name === defaults.sandboxName);
  const version = draft.version === "default" ? (defaults.versionId ?? "latest") : draft.version;
  const params = defaults.sandboxName
    ? runtimeParams(dialog, { kind: "sandbox", sandboxName: defaults.sandboxName, version })
    : [];

  async function start() {
    const checked = checkRunDraft(draft, defaults, dialog);
    if (!checked.ok) {
      setErrors(checked.errors);
      setProblem("Some fields need a change.");
      return;
    }
    setErrors({});
    setProblem(null);
    setPending(true);
    const answer = await send<{ runId: string; href: string }>(
      "POST",
      `${evalsApi(projectId)}/definitions/${evalId}/runs`,
      checked.body,
    );
    setPending(false);
    if (!answer.ok) return setProblem(answer.message);
    const changed = Object.keys(checked.body).filter((key) => key !== "name").length;
    toast({
      title: changed === 0 ? "Run started with the defaults." : "Run started with its changes.",
      tone: "success",
    });
    onOpenChange(false);
    router.push(answer.data.href);
  }

  const addRows = draft.addRows;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`New run of ${evalName}`}
        description="The defaults of the eval. A change here is for this run only, and the run records it."
        className="w-[min(40rem,calc(100vw-2rem))]"
        footer={
          <>
            <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
            <Button variant="primary" onClick={start} loading={pending}>
              Start run
            </Button>
          </>
        }
      >
        {problem ? (
          <Callout tone="danger" title="Not started">
            {problem}
          </Callout>
        ) : null}
        <Field label="Run name (optional)" error={errors.name}>
          {(control) => (
            <Input
              {...control}
              value={draft.name}
              maxLength={200}
              placeholder="First prompt, fixed prompt…"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          )}
        </Field>
        <Group title="Dataset">
          <Field label="Dataset of this run" error={errors.dataset}>
            {(control) => (
              <Select
                id={control.id}
                aria-label="Dataset of this run"
                value={draft.datasetId}
                onValueChange={(datasetId) => setDraft({ ...draft, datasetId })}
                options={dialog.datasets.map(({ id, name, kindLabel }) => ({
                  value: id,
                  label: `${name} · ${kindLabel}${id === defaults.datasetId ? " (the eval's)" : ""}`,
                }))}
              />
            )}
          </Field>
          <Choice
            legend="Add rows for this run"
            name="run-rows"
            value={addRows.kind}
            error={errors.rows}
            onChange={(kind) => setDraft({ ...draft, addRows: addRowsOf(kind) })}
            options={[
              { value: "none", label: "No more rows" },
              { value: "turns", label: "Traces that I choose" },
              { value: "last_traces", label: "The last traces" },
              { value: "auto", label: "Let Ratel choose" },
            ]}
          />
          {addRows.kind === "turns" ? (
            <TracePicker
              projectId={projectId}
              tasks={dialog.tasks}
              chosen={addRows.turnIds}
              onChange={(turnIds) => setDraft({ ...draft, addRows: { kind: "turns", turnIds } })}
            />
          ) : null}
          {addRows.kind === "last_traces" || addRows.kind === "auto" ? (
            <Field label="Traces, at most" error={errors.limit}>
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  min={1}
                  max={500}
                  className="w-28"
                  value={addRows.limit}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      addRows: { kind: addRows.kind, limit: event.target.value } as AddRowsDraft,
                    })
                  }
                />
              )}
            </Field>
          ) : null}
        </Group>
        <Group title="Runtime">
          <Field
            label={`Version of ${defaults.sandboxName ?? "the sandbox"}`}
            error={errors.version}
          >
            {(control) => (
              <Select
                id={control.id}
                aria-label="Runtime version"
                value={draft.version}
                onValueChange={(next) => setDraft({ ...draft, version: next })}
                options={[
                  {
                    value: "default",
                    label: defaults.versionId
                      ? "The eval's pinned version"
                      : "The eval's: newest ready version",
                  },
                  ...(defaults.versionId
                    ? [{ value: "latest", label: "Newest ready version" }]
                    : []),
                  ...(sandbox?.versions ?? []).map(({ id, label }) => ({
                    value: id,
                    label: `Pinned: ${label}`,
                  })),
                ]}
              />
            )}
          </Field>
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
        <Group title="Scoring">
          <Switch
            label="Other scorers for this run"
            checked={draft.scorersChanged}
            onCheckedChange={(scorersChanged) => setDraft({ ...draft, scorersChanged })}
          />
          {draft.scorersChanged ? (
            <ScorerPicker
              projectId={projectId}
              library={dialog.library}
              picks={draft.scorers}
              onChange={(scorers) => setDraft({ ...draft, scorers })}
              errors={errors}
            />
          ) : null}
          <Field label="Trials of each row" error={errors.trials}>
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

function addRowsOf(kind: AddRowsDraft["kind"]): AddRowsDraft {
  switch (kind) {
    case "none":
      return { kind };
    case "turns":
      return { kind, turnIds: [] };
    case "last_traces":
    case "auto":
      return { kind, limit: "10" };
  }
}
