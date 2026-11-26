"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Field, Textarea } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { toast } from "@ratel/design-system/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import { caseHref } from "@/lib/views/evals/paths";
import type { RunRow, VersionRow } from "@/lib/views/sandboxes/page-model";
import {
  expectedOutputOf,
  type InputDraft,
  inputDraftOf,
  inputOfDraft,
  type ParamDraft,
  paramDraftOf,
  paramsOfDraft,
} from "@/lib/views/sandboxes/run-form";
import { ParamControl } from "./ParamControl";

const POLL_MS = 1_500;
/** The runs that the list keeps: the session's and the latest of the project. */
const KEPT_RUNS = 10;
const STATUS: Record<RunRow["status"], { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Agent failed", tone: "danger" },
  infra_error: { label: "Infrastructure error", tone: "warning" },
  timed_out: { label: "Timed out", tone: "warning" },
};
/** The mode of a tool call, by the source of its result. */
const MODE = {
  real: { label: "Live", tone: "neutral" },
  fixture: { label: "Recorded", tone: "info" },
  fake: { label: "Simulated", tone: "accent" },
} as const;
const TOOL_MODE = { live: MODE.real, recorded: MODE.fixture, simulated: MODE.fake } as const;

type ToolCall = NonNullable<RunRow["result"]>["toolCalls"][number];

/** Try a ready version: an input and typed params on the left, the output first on the right. */
export function SandboxRunOnce({
  projectId,
  versions,
  runs,
  configured,
  now,
}: {
  projectId: string;
  versions: VersionRow[];
  runs: RunRow[];
  configured: boolean;
  now: string;
}) {
  const ready = versions.filter((version) => version.status === "ready");
  const [versionId, setVersionId] = useState(ready[0]?.id ?? "");
  const [history, setHistory] = useState<RunRow[]>(runs);
  const [shownId, setShownId] = useState<string | null>(runs[0]?.runId ?? null);
  const version = ready.find((candidate) => candidate.id === versionId) ?? ready[0];
  const shown = history.find((run) => run.runId === shownId) ?? null;
  const active = shown?.status === "queued" || shown?.status === "running";
  const activeId = active ? shown?.runId : undefined;

  useEffect(() => {
    if (!activeId) return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/projects/${projectId}/sandboxes/runs/${activeId}`).catch(
        () => null,
      );
      if (!response?.ok) return;
      const run = (await response.json()) as RunRow;
      setHistory((runs) => withRun(runs, run));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [activeId, projectId]);

  function remember(run: RunRow) {
    setHistory((runs) => withRun(runs, run));
  }

  return (
    <Section
      title="Try a version"
      description="Give an input and the params. Each run starts one new instance, runs the agent once and stops it."
    >
      {version ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="flex flex-col gap-4 rounded-lg border border-line bg-raised p-4">
            <Field label="Version">
              {(control) => (
                <Select
                  id={control.id}
                  aria-label="Version"
                  value={version.id}
                  onValueChange={setVersionId}
                  options={ready.map((candidate) => ({
                    value: candidate.id,
                    label: `${candidate.name} · ${candidate.commit?.slice(0, 12) ?? "no commit"} · ${candidate.id.slice(0, 8)}`,
                  }))}
                  className="w-full"
                />
              )}
            </Field>
            <RunForm
              key={version.id}
              projectId={projectId}
              version={version}
              disabled={!configured || active}
              running={active}
              onStarted={(run) => {
                remember(run);
                setShownId(run.runId);
              }}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            {shown ? (
              <RunResult projectId={projectId} run={shown} now={now} />
            ) : (
              <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-line p-6 text-ui text-fg-subtle">
                The output of a run shows here.
              </div>
            )}
            {history.length > 0 ? (
              <RunHistory
                runs={history}
                versions={versions}
                shownId={shown?.runId ?? null}
                onShow={setShownId}
                now={now}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-ui text-fg-muted">A run needs a version that is ready.</p>
      )}
    </Section>
  );
}

function RunForm({
  projectId,
  version,
  disabled,
  running,
  onStarted,
}: {
  projectId: string;
  version: VersionRow;
  disabled: boolean;
  running: boolean;
  onStarted: (run: RunRow) => void;
}) {
  const { spec } = version;
  const [input, setInput] = useState<InputDraft>(() => inputDraftOf(spec.inputExample));
  const [params, setParams] = useState<ParamDraft>(() => paramDraftOf(spec.params));
  const [inputError, setInputError] = useState<string | null>(null);
  const [paramErrors, setParamErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function start() {
    const parsedInput = inputOfDraft(input);
    const parsedParams = paramsOfDraft(spec.params, params);
    setInputError(parsedInput.ok ? null : parsedInput.error);
    setParamErrors(parsedParams.ok ? {} : parsedParams.errors);
    if (!parsedInput.ok || !parsedParams.ok) return;
    setProblem(null);
    setPending(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/sandboxes/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          versionId: version.id,
          input: parsedInput.value,
          params: parsedParams.value,
        }),
      });
      const body = (await response.json()) as RunRow & { message?: string };
      if (response.ok) onStarted(body);
      else setProblem(body.message ?? "The run did not start. Try again.");
    } catch {
      setProblem("The run did not start. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Field
        label={input.kind === "text" ? "Input" : "Input (JSON)"}
        description="Filled from the example in ratel.yaml."
        error={inputError}
      >
        {(control) => (
          <Textarea
            {...control}
            rows={6}
            value={input.text}
            spellCheck={false}
            className="font-mono"
            onChange={(event) => setInput({ ...input, text: event.target.value })}
          />
        )}
      </Field>
      {spec.params.length > 0 ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-xs font-medium text-fg-muted">Parameters</legend>
          {spec.params.map((param) => (
            <ParamControl
              key={param.name}
              param={param}
              value={params[param.name] ?? ""}
              error={paramErrors[param.name] ?? null}
              onChange={(value) => setParams({ ...params, [param.name]: value })}
            />
          ))}
        </fieldset>
      ) : (
        <p className="text-xs text-fg-subtle">This version declares no parameter.</p>
      )}
      <VersionFacts version={version} />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={start} disabled={pending || disabled}>
          {running ? "Running…" : pending ? "Starting…" : "Run"}
        </Button>
        {problem ? <p className="text-xs text-danger">{problem}</p> : null}
      </div>
    </>
  );
}

/** The tools with their mode and the run mode, as `ratel.yaml` of the version declares them. */
function VersionFacts({ version }: { version: VersionRow }) {
  const { spec } = version;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-line pt-3 text-xs">
      <dt className="text-fg-muted">Run mode</dt>
      <dd className="text-fg">
        <code className="font-mono">{spec.runMode}</code>
        {spec.timeoutSeconds ? (
          <span className="text-fg-subtle"> · timeout {spec.timeoutSeconds} s</span>
        ) : null}
      </dd>
      <dt className="text-fg-muted">Tools</dt>
      <dd className="flex flex-wrap gap-2">
        {spec.tools.length === 0 ? (
          <span className="text-fg-subtle">None declared</span>
        ) : (
          spec.tools.map((tool) => (
            <span key={tool.name} className="inline-flex items-center gap-1.5">
              <code className="font-mono text-fg">{tool.name}</code>
              <Badge tone={TOOL_MODE[tool.mode].tone}>{TOOL_MODE[tool.mode].label}</Badge>
            </span>
          ))
        )}
      </dd>
    </dl>
  );
}

/** The output first, then the tool calls, the logs and the numbers of the run. */
function RunResult({ projectId, run, now }: { projectId: string; run: RunRow; now: string }) {
  const status = STATUS[run.status];
  const { result } = run;
  const usage = result?.usage;
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line bg-raised p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="text-xs text-fg-subtle">{formatRelativeTime(run.createdAt, now)}</span>
        <span className="ml-auto flex items-center gap-3">
          {run.traceId ? (
            <Link
              href={`/project/${projectId}/traces/${run.traceId}`}
              className="text-ui text-accent-fg underline-offset-2 hover:underline"
            >
              Open the trace
            </Link>
          ) : null}
          {result?.status === "completed" ? <SaveAsCase projectId={projectId} run={run} /> : null}
        </span>
      </div>
      {run.reason && !result?.error ? <p className="text-ui text-fg-muted">{run.reason}</p> : null}
      {result?.error ? (
        <Output
          label="Error"
          value={`${result.error.type}: ${result.error.message}`}
          tone="danger"
        />
      ) : null}
      {result && !result.error ? <Output label="Output" value={result.output} /> : null}
      {!result && (run.status === "queued" || run.status === "running") ? (
        <p className="text-ui text-fg-muted">The agent is running. The output shows here.</p>
      ) : null}
      {usage ? (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <Fact label="Duration" value={`${formatSeconds(usage.durationMs)}`} />
          <Fact
            label="Cost"
            value={usage.costUsd === undefined ? "Not reported" : formatUsd(usage.costUsd)}
          />
          {usage.inputTokens !== undefined || usage.outputTokens !== undefined ? (
            <Fact
              label="Tokens"
              value={`${usage.inputTokens ?? 0} in · ${usage.outputTokens ?? 0} out`}
            />
          ) : null}
        </dl>
      ) : null}
      {result ? <ToolCalls calls={result.toolCalls} /> : null}
      <Disclosure title="Input and params">
        <pre className="max-h-60 overflow-auto rounded-md border border-line bg-rail p-3 font-mono text-xs whitespace-pre-wrap text-fg-muted">
          {JSON.stringify({ input: run.input, params: run.params }, null, 2)}
        </pre>
      </Disclosure>
      {run.logs ? (
        <Disclosure title="Logs">
          <pre className="max-h-80 overflow-auto rounded-md border border-line bg-rail p-3 font-mono text-xs whitespace-pre-wrap text-fg-muted">
            {run.logs}
          </pre>
        </Disclosure>
      ) : null}
    </div>
  );
}

/** Saves the run as a draft case: its input, and its output as the expected output. */
function SaveAsCase({ projectId, run }: { projectId: string; run: RunRow }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true);
    const failed = (description: string) => {
      setPending(false);
      toast({ title: "The case was not saved", description, tone: "danger" });
    };
    try {
      const response = await fetch(`/api/projects/${projectId}/evals/cases`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: caseNameOf(run.input),
          labels: [],
          content: {
            input: run.input,
            expectedOutput: expectedOutputOf(run.result?.output),
            scorers: [],
          },
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        caseId?: string;
        message?: string;
      };
      if (response.ok && body.caseId) router.push(caseHref(projectId, body.caseId));
      else failed(body.message ?? "Try again.");
    } catch {
      failed("Try again.");
    }
  }

  return (
    <Button size="sm" variant="secondary" onClick={save} disabled={pending}>
      {pending ? "Saving…" : "Save as case"}
    </Button>
  );
}

function RunHistory({
  runs,
  versions,
  shownId,
  onShow,
  now,
}: {
  runs: RunRow[];
  versions: VersionRow[];
  shownId: string | null;
  onShow: (runId: string) => void;
  now: string;
}) {
  const names = new Map(versions.map((version) => [version.id, version.name]));
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-fg-muted">Last runs</h3>
      <ol className="divide-y divide-line rounded-md border border-line">
        {runs.map((run) => (
          <li key={run.runId}>
            <button
              type="button"
              onClick={() => onShow(run.runId)}
              aria-current={run.runId === shownId ? "true" : undefined}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-hover aria-[current=true]:bg-selected"
            >
              <Badge tone={STATUS[run.status].tone}>{STATUS[run.status].label}</Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                {preview(run.input)}
              </span>
              <span className="text-xs text-fg-subtle">
                {names.get(run.versionId) ?? run.versionId.slice(0, 8)}
              </span>
              <span className="text-xs text-fg-faint">
                {formatRelativeTime(run.createdAt, now)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ToolCalls({ calls }: { calls: ToolCall[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-fg-muted">Tool calls</h3>
      {calls.length === 0 ? (
        <p className="text-ui text-fg-subtle">The agent called no tool.</p>
      ) : (
        <ol className="divide-y divide-line rounded-md border border-line">
          {calls.map((call, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the calls of a run never change their order
            <li key={index} className="flex flex-col gap-1.5 px-3 py-2">
              <div className="flex items-center gap-2">
                <code className="font-mono text-ui text-fg">{call.name}</code>
                <Badge tone={MODE[call.source].tone}>{MODE[call.source].label}</Badge>
                {call.durationMs !== undefined ? (
                  <span className="ml-auto text-xs text-fg-subtle">
                    {formatSeconds(call.durationMs)}
                  </span>
                ) : null}
              </div>
              <code className="font-mono text-xs break-all text-fg-muted">
                {show(call.arguments)} → {call.error ?? show(call.result)}
              </code>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Output({ label, value, tone }: { label: string; value: unknown; tone?: "danger" }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-fg-muted">{label}</h3>
      <pre
        className={
          tone === "danger"
            ? "max-h-96 overflow-auto rounded-md border border-danger/40 bg-rail p-4 font-mono text-ui whitespace-pre-wrap text-danger"
            : "max-h-96 overflow-auto rounded-md border border-line bg-rail p-4 font-sans text-sm leading-relaxed whitespace-pre-wrap text-fg"
        }
      >
        {typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2)}
      </pre>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="font-mono text-fg">{value}</dd>
    </div>
  );
}

/** The runs with this one, the newest first, at most `KEPT_RUNS`. */
function withRun(runs: RunRow[], run: RunRow): RunRow[] {
  return [run, ...runs.filter((other) => other.runId !== run.runId)]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, KEPT_RUNS);
}

function caseNameOf(input: unknown): string {
  const text = preview(input).replace(/\s+/g, " ").trim();
  return text ? `From a run: ${text.slice(0, 60)}` : "From a run";
}

function preview(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "message" in input) {
    const message = (input as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(input ?? null);
}

function formatSeconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatUsd(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}
