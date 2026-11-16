"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  addWhatIfToEvalSetAction,
  getWhatIfRunAction,
  submitWhatIfAction,
} from "@/app/(console)/(session-replay)/session-replay-actions";
import type {
  ChangeSpec,
  SideView,
  WhatIfOptions,
  WhatIfRunView,
} from "@/lib/views/session-replay/what-if";

/**
 * What if… (RC-178): at one model call of the session, pick a change, run it
 * k times on each side, and compare the tool each side picks, how often, and
 * what a sample costs. A live run is polled until it ends. The counts are a
 * sample, not proof: the panel says so.
 */

/** The model call a What-if forks: its turn, and its 0-based position in that turn. */
export interface ForkTarget {
  turnId: string;
  call: number;
}

type ChangeKind = ChangeSpec["kind"];

const POLL_MS = 2_000;
const DEFAULT_K = 5;
const MAX_K = 10;

const KIND_OPTIONS: { value: ChangeKind; label: string }[] = [
  { value: "fix", label: "A fix or a tool craft" },
  { value: "catalog_override", label: "A catalog override" },
  { value: "definition", label: "An edited tool definition" },
  { value: "remove_tool", label: "Remove a tool" },
];

const STATUS: Record<
  WhatIfRunView["status"],
  { label: string; tone: "neutral" | "info" | "success" | "danger" }
> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  completed: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

export function WhatIfPanel({
  projectId,
  target,
  options,
  runs: initialRuns,
  readContent,
}: {
  projectId: string;
  target: ForkTarget;
  options: WhatIfOptions;
  runs: readonly WhatIfRunView[];
  readContent: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<readonly WhatIfRunView[]>(initialRuns);
  const here = runs.filter((run) => run.turnId === target.turnId && run.step === target.call);
  const latest = here[0] ?? null;
  const upsert = (run: WhatIfRunView) =>
    setRuns((all) => [run, ...all.filter((item) => item.id !== run.id)]);

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4" aria-label="What if">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-fg-muted">What if…</h3>
        {!open ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            What if…
          </Button>
        ) : null}
      </div>
      {open ? (
        <ChangeForm
          projectId={projectId}
          target={target}
          options={options}
          readContent={readContent}
          onQueued={(run) => {
            upsert(run);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      ) : null}
      {latest ? (
        <RunResult key={latest.id} projectId={projectId} initial={latest} onChange={upsert} />
      ) : null}
    </div>
  );
}

function ChangeForm({
  projectId,
  target,
  options,
  readContent,
  onQueued,
  onCancel,
}: {
  projectId: string;
  target: ForkTarget;
  options: WhatIfOptions;
  readContent: boolean;
  onQueued: (run: WhatIfRunView) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<ChangeKind>(
    options.fixes.length > 0 ? "fix" : "catalog_override",
  );
  const router = useRouter();
  const [picked, setFixId] = useState(options.fixes[0]?.id ?? "");
  // A fix can be replaced while the page is open (a new tool craft run): then the first open one takes its place.
  const fixId = options.fixes.some((fix) => fix.id === picked)
    ? picked
    : (options.fixes[0]?.id ?? "");
  const [tool, setTool] = useState(options.tools[0]?.name ?? "");
  const [text, setText] = useState(() => textFor(options, kind, options.tools[0]?.name ?? ""));
  const [k, setK] = useState(String(DEFAULT_K));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const pickTool = (name: string, forKind: ChangeKind = kind) => {
    setTool(name);
    setText(textFor(options, forKind, name));
  };
  const change = (): ChangeSpec | null => {
    if (kind === "fix") return fixId ? { kind, fixId } : null;
    if (!tool) return null;
    if (kind === "remove_tool") return { kind, tool };
    if (!text.trim()) return null;
    return kind === "catalog_override"
      ? { kind, tool, searchable: text }
      : { kind, tool, description: text };
  };

  function run() {
    const spec = change();
    const samples = Number(k);
    if (!spec) return setError(kind === "fix" ? "Pick a fix." : "Pick a tool and give its text.");
    if (!Number.isInteger(samples) || samples < 1 || samples > MAX_K)
      return setError(`Runs must be a whole number from 1 to ${MAX_K}.`);
    setError(null);
    startTransition(async () => {
      const result = await submitWhatIfAction({
        projectId,
        turnId: target.turnId,
        step: target.call,
        k: samples,
        change: spec,
      });
      if (!result.ok) {
        setError(result.error);
        if (spec.kind === "fix") router.refresh();
        return;
      }
      onQueued(result.value);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="Change">
        {(control) => (
          <Select
            id={control.id}
            options={KIND_OPTIONS}
            value={kind}
            onValueChange={(value) => {
              setKind(value as ChangeKind);
              pickTool(tool, value as ChangeKind);
            }}
          />
        )}
      </Field>
      {kind === "fix" ? (
        <Field
          label="Fix"
          description={options.fixes.length === 0 ? "This project has no open fix." : undefined}
        >
          {(control) => (
            <Select
              id={control.id}
              options={options.fixes.map((fix) => ({
                value: fix.id,
                label: fix.craft ? `Tool craft: ${fix.title}` : fix.title,
              }))}
              value={fixId}
              onValueChange={setFixId}
              disabled={options.fixes.length === 0}
            />
          )}
        </Field>
      ) : (
        <Field
          label="Tool"
          description={
            options.tools.length === 0 ? "This project's catalog has no tool." : undefined
          }
        >
          {(control) => (
            <Select
              id={control.id}
              options={options.tools.map((item) => ({ value: item.name, label: item.name }))}
              value={tool}
              onValueChange={(name) => pickTool(name)}
              disabled={options.tools.length === 0}
            />
          )}
        </Field>
      )}
      {kind === "catalog_override" || kind === "definition" ? (
        <Field label={kind === "catalog_override" ? "Searchable description" : "Description"}>
          {(control) => (
            <Textarea
              {...control}
              rows={4}
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
            />
          )}
        </Field>
      ) : null}
      <Field
        label="Runs per side"
        description={
          readContent
            ? "Each run asks the model once on each side."
            : "Content reading is off: the step's search is re-ranked, without the model."
        }
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            min={1}
            max={MAX_K}
            value={k}
            onChange={(event) => setK(event.currentTarget.value)}
            className="w-24"
          />
        )}
      </Field>
      {error ? (
        <p role="alert" className="text-ui text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" loading={pending} onClick={run}>
          Run
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** One run: polled while it is live, then the comparison. */
function RunResult({
  projectId,
  initial,
  onChange,
}: {
  projectId: string;
  initial: WhatIfRunView;
  onChange: (run: WhatIfRunView) => void;
}) {
  const [run, setRun] = useState(initial);
  const [adding, startAdding] = useTransition();
  const live = run.status === "queued" || run.status === "running";

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await getWhatIfRunAction(projectId, run.id);
      if (cancelled || !result.ok) return;
      setRun(result.value);
      onChange(result.value);
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [live, projectId, run, onChange]);

  const status = STATUS[run.status];
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-3" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="text-xs text-fg-subtle">
          {run.method === "replay" ? "Model replay" : "Re-rank"} · k = {run.k}
        </span>
      </div>
      {live ? (
        <p className="text-ui text-fg-muted">Sampling the step… this updates by itself.</p>
      ) : null}
      {run.error ? <p className="text-ui text-danger">{run.error}</p> : null}
      {run.before && run.after ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui">
            <dt className="text-fg-muted">Recorded</dt>
            <dd className="font-mono">{run.recordedTool ?? "(answer)"}</dd>
            <dt className="text-fg-muted">Before</dt>
            <dd className="font-mono">{run.before.choice ?? "(answer)"}</dd>
            <dt className="text-fg-muted">After</dt>
            <dd
              className={cn(
                "font-mono",
                run.after.choice !== run.before.choice && "font-semibold text-fg",
              )}
            >
              {run.after.choice ?? "(answer)"}
            </dd>
          </dl>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-fg-subtle">
              Choices over {run.k} {run.k === 1 ? "run" : "runs"} per side: a sample, not proof.
            </p>
            <Distribution label="Before" side={run.before} k={run.k} />
            <Distribution label="After" side={run.after} k={run.k} />
          </div>
          {run.method === "rerank" ? (
            <p className="text-ui text-fg-muted">
              A re-rank calls no model: it has no token or cost change. Turn on content reading to
              replay the model.
            </p>
          ) : (
            <Cost before={run.before} after={run.after} />
          )}
          <Button
            size="sm"
            loading={adding}
            className="self-start"
            onClick={() =>
              startAdding(async () => {
                const result = await addWhatIfToEvalSetAction(projectId, run.id);
                toast(
                  result.ok
                    ? { title: "Added to the eval set", description: result.value, tone: "success" }
                    : { title: "Not added", description: result.error, tone: "danger" },
                );
              })
            }
          >
            Add to eval set
          </Button>
        </>
      ) : null}
    </div>
  );
}

function Distribution({ label, side, k }: { label: string; side: SideView; k: number }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      {side.distribution.map((item) => (
        <div
          key={item.tool}
          className="grid grid-cols-[minmax(0,1fr)_4rem_2rem] items-center gap-2 text-xs"
        >
          <span className="truncate font-mono">{item.tool}</span>
          <span className="h-1.5 rounded-full bg-line">
            <span
              className="block h-full rounded-full bg-chart-1"
              style={{ width: `${(item.count / Math.max(1, k)) * 100}%` }}
            />
          </span>
          <span className="text-right tabular-nums text-fg-muted">
            {item.count}/{k}
          </span>
        </div>
      ))}
    </div>
  );
}

function Cost({ before, after }: { before: SideView; after: SideView }) {
  const n = (value: number) => value.toLocaleString("en-US");
  const signed = (value: number, format: (v: number) => string) =>
    `${value > 0 ? "+" : value < 0 ? "−" : "±"}${format(Math.abs(value))}`;
  const usd = (value: number) => `$${value.toFixed(4)}`;
  const tokens =
    after.inputTokens + after.outputTokens - (before.inputTokens + before.outputTokens);
  const cost =
    before.costUsd !== null && after.costUsd !== null ? after.costUsd - before.costUsd : null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui">
      <dt className="text-fg-muted">Tokens per run</dt>
      <dd className="tabular-nums">
        {n(before.inputTokens + before.outputTokens)} → {n(after.inputTokens + after.outputTokens)}{" "}
        ({signed(tokens, n)})
      </dd>
      <dt className="text-fg-muted">Cost per run</dt>
      <dd className="tabular-nums">
        {cost === null
          ? "No price for this model"
          : `${usd(before.costUsd!)} → ${usd(after.costUsd!)} (${signed(cost, usd)})`}
      </dd>
    </dl>
  );
}

function textFor(options: WhatIfOptions, kind: ChangeKind, name: string): string {
  const tool = options.tools.find((item) => item.name === name);
  if (!tool) return "";
  return kind === "catalog_override" ? tool.searchable : tool.description;
}
