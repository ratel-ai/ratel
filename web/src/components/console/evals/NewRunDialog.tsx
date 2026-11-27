"use client";

import { Button } from "@ratel/design-system/button";
import { Checkbox } from "@ratel/design-system/checkbox";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PickerTurn } from "@/lib/views/evals/adapters/turn-picker";
import { DEFAULT_ROW_LIMIT } from "@/lib/views/evals/domain/dataset";
import {
  LATEST,
  matrixOf,
  type RunDefaults,
  type RunDraft,
  runDraftOf,
  runRequestOf,
} from "@/lib/views/evals/eval-dialog";
import { experimentHref } from "@/lib/views/evals/paths";
import type { LibraryEntry } from "@/lib/views/evals/scorer-library";
import type { ParamSpec } from "@/lib/views/sandboxes/run-form";
import { TurnPicker } from "./DatasetPickers";
import { ParamsFields, ScorerPicker } from "./NewEvalDialog";

export type NewRunOptions = {
  defaults: RunDefaults;
  /** The ready versions of the sandbox of the eval, the newest first. */
  versions: Array<{ id: string; commit: string; params: ParamSpec[] }>;
  datasets: Array<{ id: string; name: string; kindLabel: string }>;
  turns: PickerTurn[];
  scorers: LibraryEntry[];
  /** The scorer names of the eval, for "the scorers of the eval". */
  evalScorers: string[];
};

type RowsMode = RunDraft["addRows"]["mode"];

/**
 * "New run": the defaults of the eval, and each one can change for this run only. "Start run"
 * with nothing changed runs the eval as it is. The run records what changed.
 */
export function NewRunDialog({
  projectId,
  evalId,
  options,
  now,
}: {
  projectId: string;
  evalId: string;
  options: NewRunOptions;
  now: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const params = paramsOf(options, options.defaults.versionId);
  const [draft, setDraft] = useState<RunDraft>(() => runDraftOf(options.defaults, params));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (over: Partial<RunDraft>) => setDraft((was) => ({ ...was, ...over }));
  const shownParams = paramsOf(options, draft.versionId);
  const made = runRequestOf(draft, options.defaults, shownParams);
  const matrix = draft.matrixOn ? matrixOf(shownParams, draft.matrix) : null;
  const changes = made.ok ? Object.keys(made.request).filter((key) => key !== "name").length : 0;

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setDraft(runDraftOf(options.defaults, params));
      setProblem(null);
    }
  }

  async function start() {
    if (!made.ok) return setProblem(made.message);
    setSaving(true);
    setProblem(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/evals/definitions/${evalId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(made.request),
      });
      const body = (await response.json().catch(() => ({}))) as {
        experimentId?: string;
        message?: string;
      };
      if (!response.ok || !body.experimentId) return setProblem(body.message ?? "Try again.");
      toast({ title: "Run started", tone: "success" });
      openChange(false);
      router.push(experimentHref(projectId, body.experimentId));
    } catch {
      setProblem("Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        New run
      </Button>
      <Dialog open={open} onOpenChange={openChange}>
        <DialogContent
          title="New run"
          description="The defaults of the eval. A change here is for this run only, and the run records it."
          className="max-w-3xl"
          footer={
            <>
              <DialogClose render={<Button />}>Cancel</DialogClose>
              <Button variant="primary" onClick={start} disabled={saving || !made.ok}>
                {saving
                  ? "Starting…"
                  : changes === 0
                    ? "Start run"
                    : `Start run with ${changes === 1 ? "1 change" : `${changes} changes`}`}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-5">
            <Field label="Name" description="Optional. The time names the run otherwise.">
              {(control) => (
                <Input
                  {...control}
                  value={draft.name}
                  maxLength={200}
                  onChange={(event) => set({ name: event.currentTarget.value })}
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Dataset">
                {(control) => (
                  <Select
                    id={control.id}
                    aria-label="Dataset"
                    options={options.datasets.map(({ id, name, kindLabel }) => ({
                      value: id,
                      label: `${name} · ${kindLabel}${id === options.defaults.datasetId ? " (default)" : ""}`,
                    }))}
                    value={draft.datasetId}
                    onValueChange={(datasetId) => set({ datasetId })}
                  />
                )}
              </Field>
              <Field label="Runtime version">
                {(control) => (
                  <Select
                    id={control.id}
                    aria-label="Runtime version"
                    options={[
                      { value: LATEST, label: "Newest ready version" },
                      ...options.versions.map(({ id, commit }) => ({
                        value: id,
                        label: `Pinned: ${id.slice(0, 8)}${commit ? ` · ${commit.slice(0, 12)}` : ""}`,
                      })),
                    ]}
                    value={draft.versionId}
                    onValueChange={(versionId) => set({ versionId })}
                  />
                )}
              </Field>
            </div>
            <section className="flex flex-col gap-3 border-t border-line pt-4">
              <h3 className="text-ui font-medium text-fg">More rows for this run</h3>
              <SegmentedControl<RowsMode>
                label="More rows"
                value={draft.addRows.mode}
                onValueChange={(mode) =>
                  set({
                    addRows:
                      mode === "none"
                        ? { mode }
                        : mode === "traces"
                          ? { mode, turnIds: [] }
                          : { mode, limit: String(DEFAULT_ROW_LIMIT) },
                  })
                }
                options={[
                  { value: "none", label: "None" },
                  { value: "traces", label: "Chosen traces" },
                  { value: "last", label: "Last traces" },
                  { value: "auto", label: "Ratel chooses" },
                ]}
              />
              {draft.addRows.mode === "traces" ? (
                <TurnPicker
                  projectId={projectId}
                  turns={options.turns}
                  chosen={draft.addRows.turnIds}
                  onChange={(turnIds) => set({ addRows: { mode: "traces", turnIds } })}
                  now={now}
                />
              ) : null}
              {draft.addRows.mode === "last" || draft.addRows.mode === "auto" ? (
                <div className="flex items-center gap-3">
                  <Input
                    aria-label="Number of traces"
                    type="number"
                    min={1}
                    max={100}
                    className="w-24"
                    value={draft.addRows.limit}
                    onChange={(event) =>
                      draft.addRows.mode === "last" || draft.addRows.mode === "auto"
                        ? set({
                            addRows: { mode: draft.addRows.mode, limit: event.currentTarget.value },
                          })
                        : undefined
                    }
                  />
                  <span className="text-xs text-fg-subtle">
                    traces, resolved when the run starts. They are not rows of the dataset.
                  </span>
                </div>
              ) : null}
            </section>
            {shownParams.length > 0 ? (
              <section className="flex flex-col gap-3 border-t border-line pt-4">
                <h3 className="text-ui font-medium text-fg">Parameters</h3>
                <ParamsFields params={shownParams} draft={draft} set={set} matrix={matrix} />
              </section>
            ) : null}
            <section className="flex flex-col gap-3 border-t border-line pt-4">
              <h3 className="text-ui font-medium text-fg">Scorers</h3>
              <Checkbox
                label={`The scorers of the eval: ${options.evalScorers.join(", ") || "none"}`}
                checked={draft.scorers === null}
                onCheckedChange={(keep) => set({ scorers: keep ? null : [] })}
              />
              {draft.scorers !== null ? (
                <ScorerPicker
                  scorers={options.scorers}
                  chosen={draft.scorers}
                  onChange={(scorers) => set({ scorers })}
                  projectId={projectId}
                />
              ) : null}
            </section>
            <Field label="Trials" description="How many times each row runs, from 1 to 20.">
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  min={1}
                  max={20}
                  className="w-24"
                  value={draft.trials}
                  onChange={(event) => set({ trials: event.currentTarget.value })}
                />
              )}
            </Field>
            {problem ? (
              <Callout tone="danger" title="The run did not start">
                {problem}
              </Callout>
            ) : !made.ok ? (
              <Callout title="Before you start it">{made.message}</Callout>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The params of the chosen version, or of the newest one. */
function paramsOf(options: NewRunOptions, versionId: string): ParamSpec[] {
  const version =
    versionId === LATEST
      ? options.versions[0]
      : options.versions.find(({ id }) => id === versionId);
  return version?.params ?? options.versions[0]?.params ?? [];
}
