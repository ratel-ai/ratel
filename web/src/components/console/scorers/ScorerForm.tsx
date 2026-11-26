"use client";

import { Button } from "@ratel/design-system/button";
import { Checkbox } from "@ratel/design-system/checkbox";
import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { SegmentedControl } from "@ratel/design-system/tabs";
import Link from "next/link";
import { type FormEvent, type ReactNode, useEffect, useState, useTransition } from "react";
import {
  changeScorerAction,
  countScorerTracesAction,
  testScorerAction,
} from "@/app/(console)/project/[projectId]/scorers/actions";
import type { TaskOption } from "@/app/(console)/project/[projectId]/scorers/tasks";
import type { TraceFilterFacets } from "@/lib/synthesis/traces/trace-filters";
import { traceFilterFromSearch } from "@/lib/synthesis/traces/v2/filters";
import {
  formatInteger,
  formatPercent,
  formatTimestamp,
  shortId,
} from "@/lib/synthesis/traces/v2/format";
import { type DraftField, parseScorerDraft } from "@/lib/views/scorers/config";
import {
  FIELD_LABELS,
  KIND_LABELS,
  OPERATOR_LABELS,
  SKIP_LABELS,
  searchOfFilter,
} from "@/lib/views/scorers/format";
import { traceHref } from "@/lib/views/scorers/paths";
import type { PreviewResult } from "@/lib/views/scorers/preview";
import {
  ATTRIBUTE_PREFIX,
  CHECK_OPERATORS,
  type CheckOperator,
  type JudgeOutput,
  PRESET_KINDS,
  type PresetKind,
  SCORER_KINDS,
  type ScorerDraft,
  type ScorerKind,
  type ScorerScope,
  TRACE_FIELDS,
} from "@/lib/views/scorers/types";
import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import { TraceFilterBar } from "../traces/TraceFilterBar";
import { ScoreValue } from "./parts";

const ATTRIBUTE = "attribute";
const COUNT_DEBOUNCE_MS = 250;
const FIELD_OPTIONS = [
  ...TRACE_FIELDS.map((field) => ({ value: field as string, label: FIELD_LABELS[field] })),
  { value: ATTRIBUTE, label: "Attribute of the trace" },
];

/** What the form holds: every control of both kinds, so switching the kind loses nothing. */
interface FormState {
  name: string;
  kind: ScorerKind;
  field: string;
  attribute: string;
  op: CheckOperator;
  value: string;
  prompt: string;
  output: JudgeOutput;
  preset: PresetKind;
  /** A preset's limit, or the tool it expects. */
  max: string;
  tool: string;
  search: string;
  scope: ScorerScope;
  /** Kept when the scope is `all`, so a switch there and back loses nothing. */
  tasks: readonly string[];
  sampleRate: string;
}

type FormErrors = { field?: DraftField; error: string } | null;

/** The scorer form, what to check, which traces and a test, in a Panel of the surface that uses it. */
export function ScorerFormBody({
  projectId,
  facets,
  tasks,
  initialTask,
  scorer,
  onSaved,
  cancel,
  className,
}: {
  projectId: string;
  facets: TraceFilterFacets;
  tasks: readonly TaskOption[];
  /** The task a new scorer starts from. */
  initialTask?: string;
  /** Null: a new one. */
  scorer: (ScorerDraft & { id: string }) | null;
  /** After the action saved it. */
  onSaved: (saved: { scorerId: string; draft: ScorerDraft }) => void;
  /** The way out without a save. */
  cancel: ReactNode;
  className?: string;
}) {
  const [state, setState] = useState(() => stateOf(scorer, initialTask));
  const [problem, setProblem] = useState<FormErrors>(null);
  const [saving, startSave] = useTransition();
  const [testing, startTest] = useTransition();
  const [results, setResults] = useState<PreviewResult[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const matching = useMatchingCount(projectId, state.search, tasksOf(state));

  const set = (change: Partial<FormState>) => {
    setState((current) => ({ ...current, ...change }));
    setProblem(null);
    // A result of other settings would mislead.
    if (!("name" in change)) setResults(null);
  };
  const errorOf = (field: DraftField) => (problem?.field === field ? problem.error : undefined);

  /** The checked draft, or null after the problem is shown at its control. */
  function checked(draft: unknown): ScorerDraft | null {
    const parsed = parseScorerDraft(draft);
    if (parsed.ok) return parsed.draft;
    setProblem(parsed);
    return null;
  }

  function save(event: FormEvent) {
    event.preventDefault();
    // In a Panel, the form of the surface behind it is a parent in React's tree.
    event.stopPropagation();
    const draft = checked(draftOf(state, scorer?.enabled ?? true));
    if (!draft) return;
    startSave(async () => {
      const result = await changeScorerAction(
        scorer
          ? { projectId, action: "update", scorerId: scorer.id, draft }
          : { projectId, action: "create", draft },
      ).catch(() => ({ ok: false as const, error: "Could not save the scorer. Try again." }));
      if (!result.ok) {
        setProblem({ error: result.error });
        return;
      }
      onSaved({ scorerId: result.scorerId, draft });
    });
  }

  function test() {
    // A test needs no name yet.
    const draft = checked(draftOf({ ...state, name: state.name.trim() || "Test" }, true));
    if (!draft) return;
    setTestError(null);
    startTest(async () => {
      const result = await testScorerAction(projectId, draft);
      if (result.ok) setResults(result.results);
      else setTestError(result.error);
    });
  }

  return (
    <form noValidate onSubmit={save} className={cn("flex flex-col gap-8", className)}>
      <Section title="1. What to check">
        <div className="flex flex-col gap-4">
          <Field label="Name" error={errorOf("name")}>
            {(control) => (
              <Input
                {...control}
                value={state.name}
                maxLength={100}
                onChange={(event) => set({ name: event.currentTarget.value })}
              />
            )}
          </Field>
          <Choice label="Kind">
            <SegmentedControl
              label="Kind"
              value={state.kind}
              onValueChange={(kind) => set({ kind })}
              options={SCORER_KINDS.map((kind) => ({
                value: kind,
                label: KIND_LABELS[kind],
                disabled: scorer !== null && scorer.kind !== kind,
              }))}
            />
          </Choice>
          {state.kind === "check" ? (
            <CheckFields state={state} set={set} errorOf={errorOf} />
          ) : state.kind === "preset" ? (
            <PresetFields
              state={state}
              set={set}
              errorOf={errorOf}
              fixedPreset={scorer?.kind === "preset"}
            />
          ) : (
            <JudgeFields
              state={state}
              set={set}
              errorOf={errorOf}
              fixedOutput={scorer?.kind === "judge"}
            />
          )}
        </div>
      </Section>

      <Section
        title="2. Which traces"
        description="Every new trace, or only the ones of some tasks or that match a filter."
      >
        <div className="flex flex-col gap-4">
          <Choice label="Scope">
            <SegmentedControl
              label="Scope"
              value={state.scope}
              onValueChange={(scope) => set({ scope })}
              options={[
                { value: "all", label: "All traces" },
                { value: "tasks", label: "Tasks" },
              ]}
            />
          </Choice>
          {state.scope === "tasks" ? (
            <TaskPicker
              tasks={tasks}
              chosen={state.tasks}
              error={errorOf("tasks")}
              onChange={(chosen) => set({ tasks: chosen })}
            />
          ) : null}
          <TraceFilterBar
            tab="rollup"
            search={state.search}
            pending={false}
            facets={facets}
            searchable={false}
            onSearchChange={(next) =>
              set({ search: typeof next === "function" ? next(state.search) : next })
            }
          />
          <p className="text-ui text-fg-muted" aria-live="polite">
            {matching === null
              ? "Counting matching traces…"
              : matching === "failed"
                ? "The matching traces could not be counted."
                : `${formatInteger(matching)} ${matching === 1 ? "trace" : "traces"} of the last 7 days match.`}
          </p>
          <Field
            label="Sample rate (%)"
            description="100 scores every matching trace."
            error={errorOf("sampleRate")}
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                max={100}
                step={1}
                value={state.sampleRate}
                className="w-28"
                onChange={(event) => set({ sampleRate: event.currentTarget.value })}
              />
            )}
          </Field>
        </div>
      </Section>

      <Section
        title="3. Test"
        description="Runs on the 5 latest matching traces. Nothing is saved."
        actions={
          <Button onClick={test} loading={testing}>
            Test
          </Button>
        }
      >
        {testError ? (
          <Callout tone="danger" title="The test failed">
            {testError}
          </Callout>
        ) : results ? (
          <TestResults projectId={projectId} results={results} judged={state.kind === "judge"} />
        ) : null}
      </Section>

      {problem && !problem.field ? (
        <Callout tone="danger" title="The scorer was not saved">
          {problem.error}
        </Callout>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" loading={saving}>
          {scorer ? "Save scorer" : "Create scorer"}
        </Button>
        {cancel}
      </div>
    </form>
  );
}

/** The tasks a scorer covers, one checkbox each. */
function TaskPicker({
  tasks,
  chosen,
  error,
  onChange,
}: {
  tasks: readonly TaskOption[];
  chosen: readonly string[];
  error?: string;
  onChange: (chosen: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-xs font-medium text-fg-muted">Tasks</legend>
      {tasks.length === 0 ? (
        <p className="text-ui text-fg-muted">
          This project has no tasks yet. Agent health finds them in its traces.
        </p>
      ) : (
        <div className="flex max-h-64 max-w-96 flex-col gap-1 overflow-y-auto rounded-md border border-line p-3">
          {tasks.map(({ id, name }) => (
            <Checkbox
              key={id}
              label={name}
              checked={chosen.includes(id)}
              onCheckedChange={(checked) =>
                onChange(checked ? [...chosen, id] : chosen.filter((other) => other !== id))
              }
            />
          ))}
        </div>
      )}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : (
        <p className="text-xs text-fg-subtle">
          A trace gets its result after the next Agent health reading, which runs once a day.
        </p>
      )}
    </fieldset>
  );
}

type Controls = {
  state: FormState;
  set: (change: Partial<FormState>) => void;
  errorOf: (field: DraftField) => string | undefined;
};

const MAX_UNITS: Partial<Record<PresetKind, string>> = {
  max_latency_ms: "Most milliseconds",
  max_cost_usd: "Most USD",
  max_tool_calls: "Most tool calls",
  max_self_corrections: "Most self-corrections",
};

/** A task preset: graded on the run each trace of its tasks belongs to. */
function PresetFields({ state, set, errorOf, fixedPreset }: Controls & { fixedPreset: boolean }) {
  const unit = MAX_UNITS[state.preset];
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        label="Preset"
        description="Graded on the task run of each trace."
        error={errorOf("preset")}
      >
        {({ id }) => (
          <Select
            id={id}
            className="w-full"
            disabled={fixedPreset}
            options={PRESET_KINDS.map((preset) => ({
              value: preset,
              label: SCORER_LABELS[preset],
            }))}
            value={state.preset}
            onValueChange={(preset) => set({ preset: preset as PresetKind })}
          />
        )}
      </Field>
      {unit ? (
        <Field label={unit} error={errorOf("max")}>
          {(control) => (
            <Input
              {...control}
              type="number"
              min={0}
              value={state.max}
              onChange={(event) => set({ max: event.currentTarget.value })}
            />
          )}
        </Field>
      ) : state.preset === "expected_tool" ? (
        <Field label="Tool" error={errorOf("tool")}>
          {(control) => (
            <Input
              {...control}
              value={state.tool}
              maxLength={500}
              onChange={(event) => set({ tool: event.currentTarget.value })}
            />
          )}
        </Field>
      ) : null}
    </div>
  );
}

function CheckFields({ state, set, errorOf }: Controls) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Read" error={state.field === ATTRIBUTE ? undefined : errorOf("path")}>
          {({ id }) => (
            <Select
              id={id}
              className="w-full"
              options={FIELD_OPTIONS}
              value={state.field}
              onValueChange={(field) =>
                set({ field, ...(field === "error" ? { op: "eq", value: "true" } : {}) })
              }
            />
          )}
        </Field>
        <Field label="Operator" error={errorOf("op")}>
          {({ id }) => (
            <Select
              id={id}
              className="w-full"
              options={CHECK_OPERATORS.map((op) => ({ value: op, label: OPERATOR_LABELS[op] }))}
              value={state.op}
              onValueChange={(op) => set({ op: op as CheckOperator })}
            />
          )}
        </Field>
        {state.op === "exists" ? null : state.field === "error" ? (
          <Field label="Value" error={errorOf("value")}>
            {({ id }) => (
              <Select
                id={id}
                className="w-full"
                options={[
                  { value: "true", label: "Yes" },
                  { value: "false", label: "No" },
                ]}
                value={state.value}
                onValueChange={(value) => set({ value })}
              />
            )}
          </Field>
        ) : (
          <Field label="Value" error={errorOf("value")}>
            {(control) => (
              <Input
                {...control}
                value={state.value}
                maxLength={500}
                onChange={(event) => set({ value: event.currentTarget.value })}
              />
            )}
          </Field>
        )}
      </div>
      {state.field === ATTRIBUTE ? (
        <Field
          label="Attribute key"
          description="A key of the trace's first span, for example user.plan."
          error={errorOf("path")}
        >
          {(control) => (
            <Input
              {...control}
              className="font-mono text-xs"
              value={state.attribute}
              maxLength={180}
              onChange={(event) => set({ attribute: event.currentTarget.value })}
            />
          )}
        </Field>
      ) : null}
      <p className="text-ui text-fg-muted">
        A trace passes when this holds. A trace without the value gets no result.
      </p>
    </>
  );
}

function JudgeFields({
  state,
  set,
  errorOf,
  fixedOutput,
}: Controls & {
  /** An existing scorer keeps its answer, so its results stay on one scale. */
  fixedOutput: boolean;
}) {
  return (
    <>
      <Field
        label="Question"
        description="A model reads the trace's input and output and answers this."
        error={errorOf("prompt")}
      >
        {(control) => (
          <Textarea
            {...control}
            value={state.prompt}
            maxLength={5000}
            onChange={(event) => set({ prompt: event.currentTarget.value })}
          />
        )}
      </Field>
      <Choice label="Answer">
        <SegmentedControl
          label="Answer"
          value={state.output}
          onValueChange={(output) => set({ output })}
          options={[
            {
              value: "boolean",
              label: "Pass or fail",
              disabled: fixedOutput && state.output !== "boolean",
            },
            {
              value: "numeric",
              label: "1 to 5",
              disabled: fixedOutput && state.output !== "numeric",
            },
          ]}
        />
      </Choice>
    </>
  );
}

/** A labelled segmented control, which names itself (`Field` labels one control by id). */
function Choice({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <span aria-hidden className="text-xs font-medium text-fg-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

function TestResults({
  projectId,
  results,
  judged,
}: {
  projectId: string;
  results: readonly PreviewResult[];
  judged: boolean;
}) {
  const columns: Column<PreviewResult>[] = [
    {
      id: "trace",
      header: "Trace",
      width: "10rem",
      cell: (row) => (
        <Link
          href={traceHref(projectId, row.traceId)}
          target="_blank"
          className="whitespace-nowrap font-mono text-xs text-fg hover:underline"
        >
          {shortId(row.traceId)}
        </Link>
      ),
    },
    {
      id: "result",
      header: "Result",
      className: "w-full",
      cell: ({ outcome }) =>
        outcome.status === "scored" ? (
          <ScoreValue score={outcome.score} />
        ) : (
          <span className="text-fg-subtle">{SKIP_LABELS[outcome.reason]}</span>
        ),
    },
    ...(judged
      ? [
          {
            id: "confidence",
            header: "Confidence",
            align: "right" as const,
            width: "7rem",
            cell: ({ outcome }: PreviewResult) =>
              outcome.status === "scored" && outcome.score.confidence !== null
                ? formatPercent(outcome.score.confidence)
                : null,
          },
        ]
      : []),
    {
      id: "started",
      header: "Started",
      align: "right",
      width: "12rem",
      hiddenBelow: "sm",
      cell: (row) => (
        <span className="whitespace-nowrap text-fg-muted tabular-nums">
          {formatTimestamp(row.startedAt)}
        </span>
      ),
    },
  ];
  return (
    <DataTable
      caption="Test results"
      columns={columns}
      rows={results}
      rowKey={(row) => row.traceId}
      empty={
        <p className="px-6 py-8 text-center text-sm text-fg-muted">No trace matches this filter.</p>
      }
    />
  );
}

/** How many traces of the last 7 days the filter matches; null while it counts. */
function useMatchingCount(
  projectId: string,
  search: string,
  tasks: readonly string[] | null,
): number | "failed" | null {
  const [counted, setCounted] = useState<{ key: string; count: number | "failed" } | null>(null);
  const key = JSON.stringify([search, tasks]);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(async () => {
      const [search, tasks] = JSON.parse(key) as [string, string[] | null];
      const result = await countScorerTracesAction(
        projectId,
        traceFilterFromSearch(search),
        tasks,
      ).catch(() => null);
      if (current) setCounted({ key, count: result?.ok ? result.count : "failed" });
    }, COUNT_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [projectId, key]);
  return counted?.key === key ? counted.count : null;
}

function stateOf(scorer: ScorerDraft | null, initialTask?: string): FormState {
  const blank: FormState = {
    name: "",
    kind: "check",
    field: "duration_ms",
    attribute: "",
    op: "lte",
    value: "",
    prompt: "",
    output: "boolean",
    preset: "ends_well",
    max: "",
    tool: "",
    search: "",
    scope: initialTask ? "tasks" : "all",
    tasks: initialTask ? [initialTask] : [],
    sampleRate: "100",
  };
  if (!scorer) return blank;
  const common: FormState = {
    ...blank,
    name: scorer.name,
    kind: scorer.kind,
    search: searchOfFilter(scorer.filter),
    scope: scorer.tasks ? "tasks" : "all",
    tasks: scorer.tasks ?? [],
    sampleRate: String(scorer.sampleRate),
  };
  if (scorer.kind === "judge") return { ...common, ...scorer.config };
  if (scorer.kind === "preset") {
    const { config } = scorer;
    return {
      ...common,
      preset: config.preset,
      max: "max" in config ? String(config.max) : "",
      tool: "tool" in config ? config.tool : "",
    };
  }
  const { path, op, value } = scorer.config;
  const attribute = path.startsWith(ATTRIBUTE_PREFIX);
  return {
    ...common,
    field: attribute ? ATTRIBUTE : path,
    attribute: attribute ? path.slice(ATTRIBUTE_PREFIX.length) : "",
    op,
    value: value === undefined ? "" : String(value),
  };
}

function tasksOf({ scope, tasks }: FormState): readonly string[] | null {
  return scope === "all" ? null : tasks;
}

/** The form as `parseScorerDraft` reads it. */
function draftOf(state: FormState, enabled: boolean) {
  const path =
    state.field === ATTRIBUTE ? `${ATTRIBUTE_PREFIX}${state.attribute.trim()}` : state.field;
  return {
    name: state.name,
    kind: state.kind,
    config:
      state.kind === "check"
        ? { path, op: state.op, ...(state.op === "exists" ? {} : { value: state.value }) }
        : state.kind === "preset"
          ? presetConfigOf(state)
          : { prompt: state.prompt, output: state.output },
    filter: traceFilterFromSearch(state.search),
    tasks: tasksOf(state),
    sampleRate: state.sampleRate.trim() === "" ? Number.NaN : Number(state.sampleRate),
    enabled,
  };
}

function presetConfigOf({ preset, max, tool }: FormState) {
  if (preset === "ends_well") return { preset };
  if (preset === "expected_tool") return { preset, tool };
  return { preset, max: max.trim() === "" ? Number.NaN : Number(max) };
}
