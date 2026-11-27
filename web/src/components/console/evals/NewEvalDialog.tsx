"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Checkbox, Switch } from "@ratel/design-system/checkbox";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { SearchInput } from "@ratel/design-system/filter-bar";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { toast } from "@ratel/design-system/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import {
  type DatasetDraft,
  FREEZE_NOTE,
  KIND_HELP,
  KIND_LABELS,
} from "@/lib/views/evals/dataset-pages";
import { type DatasetKind, DEFAULT_ROW_LIMIT, QUERY_KINDS } from "@/lib/views/evals/domain/dataset";
import { DEFAULT_EVAL_TRIALS, MAX_COMBINATIONS } from "@/lib/views/evals/domain/eval";
import {
  type EvalDraft,
  evalRequestOf,
  LATEST,
  matrixOf,
  PRODUCTION_AGENT,
  type ScorerChoice,
  scorerGroups,
  searchScorers,
} from "@/lib/views/evals/eval-dialog";
import { evalHref } from "@/lib/views/evals/paths";
import type { LibraryEntry } from "@/lib/views/evals/scorer-library";
import { type ParamSpec, paramDraftOf } from "@/lib/views/sandboxes/run-form";

export type DialogSandbox = {
  name: string;
  /** The ready versions, the newest first. */
  versions: Array<{ id: string; commit: string; createdAt: string; params: ParamSpec[] }>;
};

export type NewEvalOptions = {
  sandboxes: DialogSandbox[];
  datasets: Array<{ id: string; name: string; kindLabel: string }>;
  tasks: Array<{ id: string; name: string }>;
  scorers: LibraryEntry[];
};

const PRODUCTION = "production";
const NO_TASK = "";
const QUERY_OPTIONS = [...QUERY_KINDS].map((kind) => ({ value: kind, label: KIND_LABELS[kind] }));

export function emptyDraft(options: NewEvalOptions): EvalDraft {
  const sandbox = options.sandboxes[0];
  return {
    name: "",
    taskId: NO_TASK,
    sandboxName: sandbox?.name ?? "",
    versionId: LATEST,
    dataset: options.datasets[0]
      ? { mode: "existing", datasetId: options.datasets[0].id }
      : { mode: "query", draft: queryDraft("last_traces") },
    params: paramDraftOf(sandbox?.versions[0]?.params ?? []),
    matrix: {},
    matrixOn: false,
    trials: String(DEFAULT_EVAL_TRIALS),
    scorers: [],
  };
}

/**
 * "New eval": a name and a task, the runtime, the dataset, the parameters (with a matrix) when the
 * runtime declares some, the trials and the scorers from the library. The words follow the
 * decision `eval-terms`.
 */
export function NewEvalDialog({
  projectId,
  options,
  defaultOpen = false,
}: {
  projectId: string;
  options: NewEvalOptions;
  /** Opened by the old address of the new-eval page. */
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState<EvalDraft>(() => emptyDraft(options));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (over: Partial<EvalDraft>) => setDraft((was) => ({ ...was, ...over }));
  const made = evalRequestOf(draft, paramsOf(options, draft));

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setDraft(emptyDraft(options));
      setProblem(null);
    }
  }

  function chooseSandbox(name: string) {
    const chosen = options.sandboxes.find((one) => one.name === name);
    set({
      sandboxName: name,
      versionId: LATEST,
      params: paramDraftOf(chosen?.versions[0]?.params ?? []),
      matrix: {},
      matrixOn: false,
    });
  }

  async function create() {
    if (!made.ok) return setProblem(made.message);
    setSaving(true);
    setProblem(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/evals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(made.request),
      });
      const body = (await response.json().catch(() => ({}))) as {
        evalId?: string;
        message?: string;
      };
      if (!response.ok || !body.evalId) return setProblem(body.message ?? "Try again.");
      toast({ title: `Eval ${made.request.name} created`, tone: "success" });
      openChange(false);
      router.push(evalHref(projectId, body.evalId));
    } catch {
      setProblem("Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        New eval
      </Button>
      <Dialog open={open} onOpenChange={openChange}>
        <DialogContent
          title="New eval"
          description="An eval joins a dataset, a runtime and scorers. Each run of it gets a score."
          className="max-w-3xl"
          footer={
            <>
              <DialogClose render={<Button />}>Cancel</DialogClose>
              <Button variant="primary" onClick={create} disabled={saving || !made.ok}>
                {saving ? "Creating…" : "Create eval"}
              </Button>
            </>
          }
        >
          <NewEvalFields
            projectId={projectId}
            options={options}
            draft={draft}
            set={set}
            chooseSandbox={chooseSandbox}
            problem={problem}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The fields of the dialog: shown in the dialog, and alone in a test. */
export function NewEvalFields({
  projectId,
  options,
  draft,
  set,
  chooseSandbox,
  problem,
}: {
  projectId: string;
  options: NewEvalOptions;
  draft: EvalDraft;
  set: (over: Partial<EvalDraft>) => void;
  chooseSandbox: (name: string) => void;
  problem: string | null;
}) {
  const params = paramsOf(options, draft);
  const made = evalRequestOf(draft, params);
  const matrix = draft.matrixOn ? matrixOf(params, draft.matrix) : null;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          {(control) => (
            <Input
              {...control}
              value={draft.name}
              maxLength={100}
              placeholder="Order questions"
              onChange={(event) => set({ name: event.currentTarget.value })}
            />
          )}
        </Field>
        <Field label="Task" description="Optional. The task that the eval checks.">
          {(control) => (
            <Select
              id={control.id}
              aria-label="Task"
              options={[
                { value: NO_TASK, label: "No task" },
                ...options.tasks.map(({ id, name }) => ({ value: id, label: name })),
              ]}
              value={draft.taskId}
              onValueChange={(taskId) => set({ taskId })}
            />
          )}
        </Field>
      </div>
      <Group title="Runtime" description="Where the eval runs.">
        <RuntimePicker options={options} draft={draft} chooseSandbox={chooseSandbox} set={set} />
      </Group>
      <Group title="Dataset" description="The inputs of each run.">
        <DatasetPicker options={options} draft={draft} set={set} />
      </Group>
      {params.length > 0 ? (
        <Group
          title="Parameters"
          description="The defaults of each run. A matrix runs each combination as a variant."
        >
          <ParamsFields params={params} draft={draft} set={set} matrix={matrix} />
        </Group>
      ) : null}
      <Group title="Scorers" description="Each scorer checks every trial.">
        <ScorerPicker
          scorers={options.scorers}
          chosen={draft.scorers}
          onChange={(scorers) => set({ scorers })}
          projectId={projectId}
        />
      </Group>
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
        <Callout tone="danger" title="The eval was not created">
          {problem}
        </Callout>
      ) : !made.ok && draft.name.trim() ? (
        <Callout title="Before you create it">{made.message}</Callout>
      ) : null}
    </div>
  );
}

/** The params that the chosen version declares. */
function paramsOf(options: NewEvalOptions, draft: EvalDraft): ParamSpec[] {
  const sandbox = options.sandboxes.find(({ name }) => name === draft.sandboxName);
  const version =
    draft.versionId === LATEST
      ? sandbox?.versions[0]
      : sandbox?.versions.find(({ id }) => id === draft.versionId);
  return version?.params ?? [];
}

function Group({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4">
      <div>
        <h3 className="text-ui font-medium text-fg">{title}</h3>
        <p className="text-xs text-fg-subtle">{description}</p>
      </div>
      {children}
    </section>
  );
}

function RuntimePicker({
  options,
  draft,
  chooseSandbox,
  set,
}: {
  options: NewEvalOptions;
  draft: EvalDraft;
  chooseSandbox: (name: string) => void;
  set: (over: Partial<EvalDraft>) => void;
}) {
  const sandbox = options.sandboxes.find(({ name }) => name === draft.sandboxName);
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Runtime" className="grid gap-2 sm:grid-cols-2">
        {options.sandboxes.map(({ name, versions }) => (
          <li key={name}>
            <button
              type="button"
              aria-pressed={draft.sandboxName === name}
              onClick={() => chooseSandbox(name)}
              className="flex w-full flex-col items-start gap-0.5 rounded-md border border-line px-3 py-2 text-left hover:bg-hover aria-pressed:border-accent aria-pressed:bg-accent-subtle"
            >
              <span className="text-ui font-medium text-fg">{name}</span>
              <span className="text-xs text-fg-subtle">
                Sandbox ·{" "}
                {versions.length === 1 ? "1 ready version" : `${versions.length} ready versions`}
              </span>
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            disabled
            aria-disabled
            value={PRODUCTION}
            className="flex w-full cursor-not-allowed flex-col items-start gap-0.5 rounded-md border border-dashed border-line px-3 py-2 text-left opacity-60"
          >
            <span className="flex items-center gap-2 text-ui font-medium text-fg">
              {PRODUCTION_AGENT.label}
              <Badge>{PRODUCTION_AGENT.note}</Badge>
            </span>
            <span className="text-xs text-fg-subtle">
              Run evals against the agent that serves your users.
            </span>
          </button>
        </li>
      </ul>
      {options.sandboxes.length === 0 ? (
        <p className="text-xs text-fg-subtle">
          No sandbox has a ready version. Push your agent with ratel push, on the Sandboxes page.
        </p>
      ) : null}
      {sandbox ? (
        <Field
          label="Version"
          description="The newest ready version when each run starts, or one pinned version."
        >
          {(control) => (
            <Select
              id={control.id}
              aria-label="Version"
              options={[
                { value: LATEST, label: "Newest ready version" },
                ...sandbox.versions.map(({ id, commit }) => ({
                  value: id,
                  label: `Pinned: ${id.slice(0, 8)}${commit ? ` · ${commit.slice(0, 12)}` : ""}`,
                })),
              ]}
              value={draft.versionId}
              onValueChange={(versionId) => set({ versionId })}
            />
          )}
        </Field>
      ) : null}
    </div>
  );
}

function DatasetPicker({
  options,
  draft,
  set,
}: {
  options: NewEvalOptions;
  draft: EvalDraft;
  set: (over: Partial<EvalDraft>) => void;
}) {
  const mode = draft.dataset.mode;
  const query = draft.dataset.mode === "query" ? draft.dataset.draft : queryDraft("last_traces");
  const setQuery = (over: Partial<DatasetDraft>) =>
    set({ dataset: { mode: "query", draft: { ...query, ...over } } });
  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        label="Dataset from"
        value={mode}
        onValueChange={(next) =>
          set({
            dataset:
              next === "existing"
                ? { mode: "existing", datasetId: options.datasets[0]?.id ?? "" }
                : { mode: "query", draft: query },
          })
        }
        options={[
          { value: "existing", label: "A dataset", disabled: options.datasets.length === 0 },
          { value: "query", label: "New from traces" },
        ]}
      />
      {draft.dataset.mode === "existing" ? (
        <Select
          aria-label="Dataset"
          options={options.datasets.map(({ id, name, kindLabel }) => ({
            value: id,
            label: `${name} · ${kindLabel}`,
          }))}
          value={draft.dataset.datasetId}
          onValueChange={(datasetId) => set({ dataset: { mode: "existing", datasetId } })}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="Traces" description={KIND_HELP[query.kind]}>
            {(control) => (
              <Select
                id={control.id}
                aria-label="Traces"
                options={QUERY_OPTIONS}
                value={query.kind}
                onValueChange={(kind) => setQuery({ kind: kind as DatasetKind })}
              />
            )}
          </Field>
          {query.kind === "task_traces" || query.kind === "auto" ? (
            <Select
              aria-label="Task of the traces"
              options={[
                ...(query.kind === "auto" ? [{ value: "", label: "Each task" }] : []),
                ...options.tasks.map(({ id, name }) => ({ value: id, label: name })),
              ]}
              placeholder="Choose a task"
              value={query.taskId}
              onValueChange={(taskId) => setQuery({ taskId })}
            />
          ) : null}
          {query.kind === "rql" ? (
            <Textarea
              aria-label="RQL query"
              rows={3}
              className="font-mono text-xs"
              placeholder="select trace_id from traces where has_error limit 20"
              value={query.rql}
              onChange={(event) => setQuery({ rql: event.currentTarget.value })}
            />
          ) : null}
          <div className="flex items-center gap-3">
            <Input
              aria-label="Number of traces"
              type="number"
              min={1}
              max={500}
              className="w-24"
              value={query.limit}
              onChange={(event) => setQuery({ limit: event.currentTarget.value })}
            />
            <span className="text-xs text-fg-subtle">
              traces at most. {FREEZE_NOTE.split(".")[0]}.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** What the param fields edit: the defaults, and the values of the matrix. */
type ParamState = Pick<EvalDraft, "params" | "matrix" | "matrixOn">;

export function ParamsFields({
  params,
  draft,
  set,
  matrix,
}: {
  params: readonly ParamSpec[];
  draft: ParamState;
  set: (over: Partial<ParamState>) => void;
  matrix: ReturnType<typeof matrixOf> | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Switch
        label="Matrix: try several values"
        checked={draft.matrixOn}
        onCheckedChange={(matrixOn) => set({ matrixOn })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {params.map((param) => (
          <Field
            key={param.name}
            label={param.name}
            description={
              draft.matrixOn
                ? `Values with commas${param.options.length > 0 ? `: ${param.options.join(", ")}` : param.type === "boolean" ? ": true, false" : ""}. Empty: the default.`
                : (param.description ?? undefined)
            }
          >
            {(control) =>
              draft.matrixOn ? (
                <Input
                  {...control}
                  value={draft.matrix[param.name] ?? ""}
                  placeholder={String(draft.params[param.name] ?? "")}
                  onChange={(event) =>
                    set({ matrix: { ...draft.matrix, [param.name]: event.currentTarget.value } })
                  }
                />
              ) : param.type === "boolean" ? (
                <Checkbox
                  label="On"
                  checked={draft.params[param.name] === true}
                  onCheckedChange={(on) => set({ params: { ...draft.params, [param.name]: on } })}
                />
              ) : param.type === "enum" ? (
                <Select
                  id={control.id}
                  aria-label={param.name}
                  options={param.options.map((option) => ({
                    value: String(option),
                    label: String(option),
                  }))}
                  value={String(draft.params[param.name] ?? "")}
                  onValueChange={(value) =>
                    set({ params: { ...draft.params, [param.name]: value } })
                  }
                />
              ) : (
                <Input
                  {...control}
                  value={String(draft.params[param.name] ?? "")}
                  onChange={(event) =>
                    set({ params: { ...draft.params, [param.name]: event.currentTarget.value } })
                  }
                />
              )
            }
          </Field>
        ))}
      </div>
      {matrix ? (
        <p className={matrix.ok ? "text-xs text-fg-subtle" : "text-xs text-danger"} role="status">
          {matrix.ok
            ? `${matrix.count === 1 ? "1 combination" : `${matrix.count} combinations`} of at most ${MAX_COMBINATIONS}.`
            : matrix.message}
        </p>
      ) : null}
    </div>
  );
}

export function ScorerPicker({
  scorers,
  chosen,
  onChange,
  projectId,
}: {
  scorers: readonly LibraryEntry[];
  chosen: readonly ScorerChoice[];
  onChange: (scorers: ScorerChoice[]) => void;
  projectId: string;
}) {
  const [search, setSearch] = useState("");
  const groups = scorerGroups(searchScorers(scorers, search));
  const isChosen = (entry: LibraryEntry) =>
    chosen.some(({ source, id }) => source === entry.source && id === entry.id);
  const toggle = (entry: LibraryEntry, on: boolean) => {
    if (entry.source === "eval") return;
    const source = entry.source;
    onChange(
      on
        ? [
            ...chosen,
            {
              source,
              id: entry.id,
              name: entry.name,
              settings: entry.settings.map(({ name, type }) => ({ name, type, value: "" })),
            },
          ]
        : chosen.filter((one) => !(one.source === source && one.id === entry.id)),
    );
  };
  const setSetting = (entry: LibraryEntry, name: string, value: string) =>
    onChange(
      chosen.map((one) =>
        one.source === entry.source && one.id === entry.id
          ? { ...one, settings: one.settings.map((s) => (s.name === name ? { ...s, value } : s)) }
          : one,
      ),
    );
  const list = (title: string, entries: LibraryEntry[], empty: ReactNode) => (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-fg-subtle">{title}</h4>
      {entries.length === 0 ? (
        <p className="text-xs text-fg-faint">{empty}</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {entries.map((entry) => {
            const on = isChosen(entry);
            const choice = chosen.find(
              ({ source, id }) => source === entry.source && id === entry.id,
            );
            return (
              <li key={`${entry.source}:${entry.id}`} className="flex flex-col gap-2 px-3 py-2">
                <div className="flex items-start gap-3">
                  <Checkbox
                    aria-label={entry.name}
                    checked={on}
                    disabled={!entry.usable}
                    onCheckedChange={(next) => toggle(entry, next)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-ui text-fg">
                      {entry.name}
                      <Badge>{entry.kind === "judge" ? "Judge" : "Check"}</Badge>
                    </div>
                    <p className="text-xs text-fg-subtle">{entry.why ?? entry.description}</p>
                  </div>
                </div>
                {on && choice && choice.settings.length > 0 ? (
                  <div className="ml-7 flex flex-wrap gap-2">
                    {choice.settings.map((setting) => (
                      <Input
                        key={setting.name}
                        aria-label={`${entry.name}: ${setting.name}`}
                        placeholder={
                          entry.settings.find(({ name }) => name === setting.name)?.description ??
                          setting.name
                        }
                        className="w-64"
                        value={setting.value}
                        onChange={(event) =>
                          setSetting(entry, setting.name, event.currentTarget.value)
                        }
                      />
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="Search scorers"
          label="Search scorers"
        />
        <span className="text-xs text-fg-subtle">
          {chosen.length === 1 ? "1 chosen" : `${chosen.length} chosen`}
        </span>
      </div>
      {list(
        "This project",
        groups.project,
        <>
          No scorer of this project yet.{" "}
          <Link href={`/project/${projectId}/dashboards`} className="underline hover:text-fg">
            Create a scorer
          </Link>
          .
        </>,
      )}
      {list("Pre-defined", groups.predefined, "No pre-defined scorer matches.")}
    </div>
  );
}

function queryDraft(kind: DatasetKind): DatasetDraft {
  return { kind, limit: String(DEFAULT_ROW_LIMIT), taskId: "", rql: "" };
}
