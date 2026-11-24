"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { toast } from "@ratel/design-system/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState, useTransition } from "react";
import {
  changeScorerAction,
  countScorerTracesAction,
  testScorerAction,
} from "@/app/(console)/project/[projectId]/scorers/actions";
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
import { scorersHref, traceHref } from "@/lib/views/scorers/paths";
import type { PreviewResult } from "@/lib/views/scorers/preview";
import {
  ATTRIBUTE_PREFIX,
  CHECK_OPERATORS,
  type CheckOperator,
  type JudgeOutput,
  SCORER_KINDS,
  type ScorerDraft,
  type ScorerKind,
  TRACE_FIELDS,
} from "@/lib/views/scorers/types";
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
  search: string;
  sampleRate: string;
}

type FormErrors = { field?: DraftField; error: string } | null;

/** Create or edit a scorer: what to check, which traces, and a test, on one page. */
export function ScorerForm({
  projectId,
  facets,
  scorer,
}: {
  projectId: string;
  facets: TraceFilterFacets;
  /** Null: a new one. */
  scorer: (ScorerDraft & { id: string }) | null;
}) {
  const router = useRouter();
  const root = scorersHref(projectId);
  const [state, setState] = useState(() => stateOf(scorer));
  const [problem, setProblem] = useState<FormErrors>(null);
  const [saving, startSave] = useTransition();
  const [testing, startTest] = useTransition();
  const [results, setResults] = useState<PreviewResult[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const matching = useMatchingCount(projectId, state.search);

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
    const draft = checked(draftOf(state, scorer?.enabled ?? true));
    if (!draft) return;
    startSave(async () => {
      const result = await changeScorerAction(
        scorer
          ? { projectId, action: "update", scorerId: scorer.id, draft }
          : { projectId, action: "create", draft },
      );
      if (!result.ok) {
        setProblem({ error: result.error });
        return;
      }
      toast({ title: scorer ? "Scorer saved" : "Scorer created", tone: "success" });
      router.push(`${root}/${result.scorerId}`);
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
    <Page>
      <PageHeader
        crumbs={[
          { label: "Scorers", href: root },
          ...(scorer ? [{ label: scorer.name, href: `${root}/${scorer.id}` }] : []),
        ]}
        title={scorer ? "Edit scorer" : "New scorer"}
      />
      <PageBody>
        <form noValidate onSubmit={save} className="flex max-w-3xl flex-col gap-8">
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
            description="Every new trace, or only the ones that match a filter."
          >
            <div className="flex flex-col gap-4">
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
              <TestResults
                projectId={projectId}
                results={results}
                judged={state.kind === "judge"}
              />
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
            <Link
              href={scorer ? `${root}/${scorer.id}` : root}
              className={buttonVariants({ variant: "ghost" })}
            >
              Cancel
            </Link>
          </div>
        </form>
      </PageBody>
    </Page>
  );
}

type Controls = {
  state: FormState;
  set: (change: Partial<FormState>) => void;
  errorOf: (field: DraftField) => string | undefined;
};

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
function useMatchingCount(projectId: string, search: string): number | "failed" | null {
  const [counted, setCounted] = useState<{ search: string; count: number | "failed" } | null>(null);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(async () => {
      const result = await countScorerTracesAction(projectId, traceFilterFromSearch(search)).catch(
        () => null,
      );
      if (current) setCounted({ search, count: result?.ok ? result.count : "failed" });
    }, COUNT_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [projectId, search]);
  return counted?.search === search ? counted.count : null;
}

function stateOf(scorer: ScorerDraft | null): FormState {
  const blank: FormState = {
    name: "",
    kind: "check",
    field: "duration_ms",
    attribute: "",
    op: "lte",
    value: "",
    prompt: "",
    output: "boolean",
    search: "",
    sampleRate: "100",
  };
  if (!scorer) return blank;
  const common = {
    ...blank,
    name: scorer.name,
    kind: scorer.kind,
    search: searchOfFilter(scorer.filter),
    sampleRate: String(scorer.sampleRate),
  };
  if (scorer.kind === "judge") return { ...common, ...scorer.config };
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
        : { prompt: state.prompt, output: state.output },
    filter: traceFilterFromSearch(state.search),
    sampleRate: state.sampleRate.trim() === "" ? Number.NaN : Number(state.sampleRate),
    enabled,
  };
}
