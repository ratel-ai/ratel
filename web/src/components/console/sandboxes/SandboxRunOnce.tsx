"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Field, Textarea } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { RunRow, VersionRow } from "@/lib/views/sandboxes/page-model";

const POLL_MS = 1_500;
const STATUS: Record<RunRow["status"], { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Agent failed", tone: "danger" },
  infra_error: { label: "Infrastructure error", tone: "warning" },
  timed_out: { label: "Timed out", tone: "warning" },
};
const SOURCE = {
  real: { label: "Ran for real", tone: "neutral" },
  fixture: { label: "Fixture", tone: "info" },
  fake: { label: "Faked", tone: "accent" },
} as const;

/** One input on a ready version, with the output, the tool calls and the trace. */
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
  const [text, setText] = useState('{ "message": "" }');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [run, setRun] = useState<RunRow | null>(runs[0] ?? null);
  const selected = ready.some((version) => version.id === versionId) ? versionId : ready[0]?.id;
  const active = run?.status === "queued" || run?.status === "running";
  const runId = run?.runId;

  useEffect(() => {
    if (!active || !runId) return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/projects/${projectId}/sandboxes/runs/${runId}`).catch(
        () => null,
      );
      if (response?.ok) setRun((await response.json()) as RunRow);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, runId, projectId]);

  async function start() {
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      setError("The input must be JSON.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/sandboxes/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionId: selected, input }),
      });
      const body = (await response.json()) as RunRow & { message?: string };
      if (response.ok) setRun(body);
      else setError(body.message ?? "The run did not start. Try again.");
    } catch {
      setError("The run did not start. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Section title="Run once" description="Starts one new instance, runs the agent and stops it.">
      {ready.length === 0 ? (
        <p className="text-ui text-fg-muted">A run needs a version that is ready.</p>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <Select
            aria-label="Version"
            value={selected}
            onValueChange={setVersionId}
            options={ready.map((version) => ({
              value: version.id,
              label: `${version.name} · ${version.commit.slice(0, 12)} · ${version.id.slice(0, 8)}`,
            }))}
            className="w-full max-w-md"
          />
          <Field label="Input (JSON)" className="w-full max-w-2xl" error={error}>
            {(control) => (
              <Textarea
                {...control}
                rows={4}
                value={text}
                spellCheck={false}
                className="font-mono"
                onChange={(event) => setText(event.target.value)}
              />
            )}
          </Field>
          <Button
            variant="primary"
            onClick={start}
            disabled={pending || active || !configured || !selected}
          >
            {active ? "Running…" : "Run once"}
          </Button>
        </div>
      )}
      {run ? <RunPanel projectId={projectId} run={run} now={now} /> : null}
    </Section>
  );
}

function RunPanel({ projectId, run, now }: { projectId: string; run: RunRow; now: string }) {
  const status = STATUS[run.status];
  const { result } = run;
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line bg-raised p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={status.tone}>{status.label}</Badge>
        <code className="font-mono text-xs text-fg-faint">{run.runId}</code>
        <span className="text-xs text-fg-subtle">{formatRelativeTime(run.createdAt, now)}</span>
        {run.traceId ? (
          <Link
            href={`/project/${projectId}/traces/${run.traceId}`}
            className="ml-auto text-ui text-accent-fg underline-offset-2 hover:underline"
          >
            Open the trace
          </Link>
        ) : null}
      </div>
      {run.reason ? <p className="text-ui text-fg-muted">{run.reason}</p> : null}
      <Block label="Input" value={run.input} />
      {result?.error ? (
        <Block label="Error" value={`${result.error.type}: ${result.error.message}`} />
      ) : null}
      {result && !result.error ? <Block label="Output" value={result.output} /> : null}
      {result ? <ToolCalls calls={result.toolCalls} /> : null}
    </div>
  );
}

function ToolCalls({ calls }: { calls: NonNullable<RunRow["result"]>["toolCalls"] }) {
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
                <Badge tone={SOURCE[call.source].tone}>{SOURCE[call.source].label}</Badge>
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

function Block({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-fg-muted">{label}</h3>
      <pre className="max-h-80 overflow-auto rounded-md border border-line bg-rail p-3 font-mono text-xs whitespace-pre-wrap text-fg">
        {typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2)}
      </pre>
    </div>
  );
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}
