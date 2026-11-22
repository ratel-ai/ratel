"use client";

import { Badge, StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { DotLoaderLazy } from "@ratel/design-system/dot-loader-lazy";
import { Textarea } from "@ratel/design-system/input";
import { GitCompare, History, Pin, Square, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { formatDuration, formatInteger } from "@/lib/synthesis/traces/v2/format";
import type { SessionReplayModel } from "@/lib/views/sandboxes/replay/session-page";
import type { RecordedToolCall } from "@/lib/views/sandboxes/replay/session-source";
import {
  armDivergence,
  type ReplayArmTotals,
  type ReplayArmTurn,
  type ReplayedCall,
  replayTotals,
  replyDiff,
  type ToolCallChange,
  toolCallDiff,
} from "@/lib/views/sandboxes/replay/turn-compare";
import { canPin, toolBadge } from "@/lib/views/sandboxes/tools-state";
import { runStatus, traceHref } from "./types";
import type { ReplayPin } from "./useReplayPins";
import type { SessionReplayRow, SessionReplayState } from "./useSessionReplay";

type PinFn = (call: ReplayedCall, result: unknown, isError: boolean) => Promise<boolean>;

/**
 * A recorded session replayed in its sandbox (RC-1110, spec §9): one run per
 * recorded user message, tools fake with recorded matches. With Compare, each
 * turn shows the baseline (code defaults) and the candidate (edits) side by
 * side with the reply diff, the tool call diff, tokens, cost and latency; a
 * turn whose tool calls leave the recorded path is marked diverged.
 */
export function SessionReplayView({
  projectId,
  replay,
  state,
  changed,
  canRun,
  onReplay,
  onStop,
  onClose,
  pins = [],
  onPin,
  onUnpin,
}: {
  projectId: string;
  replay: SessionReplayModel;
  state: SessionReplayState;
  changed: readonly string[];
  canRun: boolean;
  onReplay: (compare: boolean) => void;
  onStop: () => void;
  onClose: () => void;
  /** The pins of the replay session: they answer both arms of the next run. */
  pins?: readonly ReplayPin[];
  /** Pins a fake result (as edited) in the replay session. Absent before the first run. */
  onPin?: PinFn;
  onUnpin?: (pin: ReplayPin) => Promise<boolean>;
}) {
  const sessionHref = `/project/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(replay.state === "ready" ? replay.source.sessionId : replay.sessionId)}`;
  if (replay.state === "unavailable") {
    return (
      <section
        aria-label="Session replay"
        className="flex flex-col gap-2 rounded-lg border border-line p-4"
        data-replay="unavailable"
      >
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <History className="size-4" aria-hidden />
          Replay is not possible
        </h2>
        <p className="text-ui text-fg-muted">{replay.message}</p>
        <Link
          href={sessionHref}
          className="text-xs text-fg-subtle underline-offset-2 hover:text-fg hover:underline"
        >
          Recorded session
        </Link>
      </section>
    );
  }
  const { source, match } = replay;
  const running = state.phase === "running";
  const recorded = source.turns.map((turn) => turn.toolCalls);
  const rows = state.rows;
  const done = rows.filter(
    (row) => ended(row.candidate) && (!row.baseline || ended(row.baseline)),
  ).length;
  // Once a replay ran, the next one runs again in its session, with its pins.
  const again = state.sessionId !== null && state.phase !== "idle";

  return (
    <section
      aria-label="Session replay"
      className="flex flex-col gap-3 rounded-lg border border-line p-4"
      data-replay="ready"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <History className="size-4" aria-hidden />
          Replay of a recorded session
        </h2>
        <Badge>{`${source.turns.length} ${source.turns.length === 1 ? "turn" : "turns"}`}</Badge>
        {match ? (
          <Badge tone="info">
            {match.by === "sandbox_id" ? "matched by ratel.sandbox.id" : "matched by agent name"}
          </Badge>
        ) : null}
        <Link
          href={sessionHref}
          className="text-xs text-fg-subtle underline-offset-2 hover:text-fg hover:underline"
        >
          Recorded session
        </Link>
        {running ? <DotLoaderLazy label="Replaying" size="sm" /> : null}
        <span className="ml-auto flex items-center gap-2">
          {running ? (
            <Button size="sm" onClick={onStop}>
              <Square className="size-3.5" aria-hidden />
              Stop after this turn
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={() => onReplay(false)} disabled={!canRun}>
                <History className="size-3.5" aria-hidden />
                {again ? "Run again" : "Replay"}
              </Button>
              <Button size="sm" variant="primary" onClick={() => onReplay(true)} disabled={!canRun}>
                <GitCompare className="size-3.5" aria-hidden />
                {again ? "Compare again" : "Compare baseline and candidate"}
              </Button>
            </>
          )}
          {state.phase !== "idle" && !running ? (
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Clear the replay">
              <X className="size-3.5" aria-hidden />
              Clear
            </Button>
          ) : null}
        </span>
      </div>
      <p className="text-xs text-fg-subtle">
        One run per recorded user message. Tools are fake: a call the recording made answers with
        its recorded result.{" "}
        {state.phase === "idle"
          ? `Candidate: ${changed.length > 0 ? changed.join(", ") : "no changes (same as baseline)"}.`
          : `${done} of ${rows.length} turns done · candidate: ${state.overrides.length > 0 ? state.overrides.join(", ") : "no changes (same as baseline)"}.`}
      </p>
      {state.error ? <p className="text-ui text-warning">{state.error}</p> : null}
      {again || pins.length > 0 ? <PinList pins={pins} onUnpin={onUnpin} /> : null}

      {state.phase === "idle" ? (
        <ol className="flex flex-col gap-1.5">
          {source.turns.map((turn) => (
            <li key={turn.turnIndex} className="flex gap-2 text-ui">
              <span className="w-12 shrink-0 text-fg-subtle tabular-nums">
                Turn {turn.turnIndex + 1}
              </span>
              <span className="min-w-0 text-fg">{turn.userMessage}</span>
              {turn.toolCalls.length > 0 ? (
                <span className="shrink-0 text-xs text-fg-subtle">
                  {turn.toolCalls.map((call) => call.tool).join(" → ")}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <>
          <ol className="flex flex-col gap-3">
            {rows.map((row, index) => (
              <TurnCard
                key={row.turn.turnIndex}
                projectId={projectId}
                row={row}
                recorded={recorded[index] ?? []}
                compare={state.compare}
                onPin={running ? undefined : onPin}
              />
            ))}
          </ol>
          <TotalsRow compare={state.compare} rows={rows} recorded={recorded} />
        </>
      )}
    </section>
  );
}

function TurnCard({
  projectId,
  row,
  recorded,
  compare,
  onPin,
}: {
  projectId: string;
  row: SessionReplayRow;
  recorded: readonly RecordedToolCall[];
  compare: boolean;
  onPin?: PinFn;
}) {
  const both = compare && row.baseline?.status === "ok" && row.candidate.status === "ok";
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-line p-3"
      data-turn={row.turn.turnIndex + 1}
    >
      <div className="flex gap-2 text-ui">
        <span className="shrink-0 text-fg-subtle tabular-nums">Turn {row.turn.turnIndex + 1}</span>
        <span className="min-w-0 font-medium text-fg">{row.turn.userMessage}</span>
      </div>
      <p className="text-xs text-fg-subtle">
        Recorded tools:{" "}
        {recorded.length > 0 ? recorded.map((call) => call.tool).join(" → ") : "none"}
      </p>
      <div className={cn("grid gap-3", compare && "md:grid-cols-2")}>
        {compare && row.baseline ? (
          <ArmColumn
            projectId={projectId}
            title="Baseline (code)"
            arm={row.baseline}
            recorded={recorded}
            onPin={onPin}
          />
        ) : null}
        <ArmColumn
          projectId={projectId}
          title={compare ? "Candidate (edits)" : "Replay"}
          arm={row.candidate}
          recorded={recorded}
          onPin={onPin}
        />
      </div>
      {both ? <TurnDiff baseline={row.baseline!} candidate={row.candidate} /> : null}
    </li>
  );
}

function ArmColumn({
  projectId,
  title,
  arm,
  recorded,
  onPin,
}: {
  projectId: string;
  title: string;
  arm: ReplayArmTurn;
  recorded: readonly RecordedToolCall[];
  onPin?: PinFn;
}) {
  const status = runStatus(arm.status);
  const path = armDivergence(recorded, arm);
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-arm={title}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-fg-muted">{title}</span>
        <StatusDot tone={status.tone} label={status.label} />
        {path?.diverged ? (
          <Badge tone="warning">Diverged at call {(path.firstOffPath ?? 0) + 1}</Badge>
        ) : path && arm.status === "ok" ? (
          <Badge tone="success">On the recorded path</Badge>
        ) : null}
      </div>
      {arm.calls.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {arm.calls.map((call, i) => (
            <li key={i} className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-fg">
                <span className="rounded border border-line px-1.5 py-0.5">
                  {call.tool}{" "}
                  <span className="text-fg-subtle">
                    {toolBadge({ mode: call.mode, done: true, fakeSource: call.fakeSource })}
                  </span>
                </span>
                <span className="min-w-0 truncate text-fg-subtle">{short(call.args, 60)}</span>
              </span>
              {onPin &&
              canPin({
                mode: call.mode,
                done: call.done ?? true,
                fakeSource: call.fakeSource,
                isError: call.isError,
              }) ? (
                <PinControl call={call} onPin={onPin} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {arm.reply ? (
        <p className="line-clamp-6 text-ui whitespace-pre-wrap text-fg">{arm.reply}</p>
      ) : null}
      {arm.error ? <p className="text-xs text-danger">{arm.error}</p> : null}
      <p className="flex flex-wrap gap-3 text-xs text-fg-subtle tabular-nums">
        <span>{metric(arm, (m) => `${formatInteger(m.inputTokens + m.outputTokens)} tokens`)}</span>
        <span>{metric(arm, (m) => usd(m.costUsd))}</span>
        <span>
          {metric(arm, (m) => (m.latencyMs === null ? "–" : formatDuration(m.latencyMs)))}
        </span>
        {arm.traceId ? (
          <Link
            href={traceHref(projectId, arm.traceId)}
            className="underline-offset-2 hover:text-fg hover:underline"
          >
            Trace
          </Link>
        ) : null}
      </p>
    </div>
  );
}

/** "Pin this result": the fake's value, edited first, answers this tool with these arguments in both arms of the next run. */
function PinControl({ call, onPin }: { call: ReplayedCall; onPin: PinFn }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(call.result ?? null, null, 2));
  const [state, setState] = useState<"idle" | "pinning" | "pinned" | "invalid" | "failed">("idle");
  async function save() {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      setState("invalid");
      return;
    }
    setState("pinning");
    const ok = await onPin(call, value, false);
    setState(ok ? "pinned" : "failed");
    if (ok) setEditing(false);
  }
  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEditing(true)}
          disabled={state === "pinned"}
        >
          <Pin className="size-3.5" aria-hidden />
          {state === "pinned" ? "Pinned" : "Pin this result"}
        </Button>
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1.5" data-pin-editor={call.tool}>
      <Textarea
        aria-label={`Pinned value of ${call.tool}`}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setState("idle");
        }}
        spellCheck={false}
        className="min-h-24 font-mono text-xs"
      />
      <span className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() => void save()}
          loading={state === "pinning"}
        >
          <Pin className="size-3.5" aria-hidden />
          Pin
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        {state === "invalid" ? (
          <span className="text-xs text-danger">The value is not valid JSON.</span>
        ) : null}
        {state === "failed" ? (
          <span className="text-xs text-danger">Couldn&apos;t pin. Try again.</span>
        ) : null}
      </span>
    </div>
  );
}

/** The replay session's pins, with remove. They answer both arms of the next run. */
function PinList({
  pins,
  onUnpin,
}: {
  pins: readonly ReplayPin[];
  onUnpin?: (pin: ReplayPin) => Promise<boolean>;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line p-3" aria-label="Pins">
      <span className="flex items-center gap-2 text-xs font-medium text-fg-muted">
        <Pin className="size-3.5" aria-hidden />
        Pins of this replay: both arms of the next run get these values
      </span>
      {pins.length === 0 ? (
        <span className="text-xs text-fg-subtle">
          No pins yet. Pin a fake result on a turn below.
        </span>
      ) : (
        <ul className="flex flex-col gap-1">
          {pins.map((pin) => (
            <li
              key={`${pin.tool}|${JSON.stringify(pin.args)}`}
              className="flex items-center gap-2 font-mono text-xs"
            >
              <span className="text-fg">{pin.tool}</span>
              <span className="min-w-0 truncate text-fg-subtle">{short(pin.args, 50)}</span>
              <span className="text-fg-subtle">→</span>
              <span className="min-w-0 truncate text-fg">{short(pin.result, 60)}</span>
              {onUnpin ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => void onUnpin(pin)}
                  aria-label={`Remove the pin of ${pin.tool}`}
                >
                  <X className="size-3.5" aria-hidden />
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TurnDiff({ baseline, candidate }: { baseline: ReplayArmTurn; candidate: ReplayArmTurn }) {
  const reply = replyDiff(baseline.reply, candidate.reply);
  const calls = toolCallDiff(baseline.calls, candidate.calls);
  const callsChanged = calls.some((change) => change.kind !== "same");
  return (
    <div className="grid gap-3 border-t border-line pt-2 md:grid-cols-2" aria-label="Diff">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-medium text-fg-muted">Output diff</span>
        {reply.same ? (
          <span className="text-ui text-fg-muted">Same reply</span>
        ) : (
          <p className="line-clamp-8 text-ui whitespace-pre-wrap">
            {reply.parts.map((part, i) => (
              <span
                key={i}
                className={cn(
                  part.kind === "removed" && "bg-danger-subtle text-danger line-through",
                  part.kind === "added" && "bg-success-subtle text-success",
                  part.kind === "same" && "text-fg-muted",
                )}
              >
                {part.text}
              </span>
            ))}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-medium text-fg-muted">Tool call diff</span>
        {calls.length === 0 ? (
          <span className="text-ui text-fg-muted">No tool calls</span>
        ) : !callsChanged ? (
          <span className="text-ui text-fg-muted">Same tool calls</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {calls.map((change, i) => (
              <ToolChange key={i} change={change} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ToolChange({ change }: { change: ToolCallChange }) {
  const label = { same: "same", changed: "changed arguments", added: "added", removed: "removed" }[
    change.kind
  ];
  const tone = {
    same: "text-fg-muted",
    changed: "text-warning",
    added: "text-success",
    removed: "text-danger",
  }[change.kind];
  return (
    <li className="font-mono text-xs break-words">
      <span className={tone}>{change.tool}</span> <span className="text-fg-subtle">{label}</span>
      {change.kind === "changed" ? (
        <span className="block text-fg-subtle">
          <span className="line-through">{short(change.baseline)}</span> →{" "}
          <span className="text-fg">{short(change.candidate)}</span>
        </span>
      ) : change.kind !== "same" ? (
        <span className="block text-fg-subtle">
          {short(change.kind === "added" ? change.candidate : change.baseline)}
        </span>
      ) : null}
    </li>
  );
}

function TotalsRow({
  compare,
  rows,
  recorded,
}: {
  compare: boolean;
  rows: readonly SessionReplayRow[];
  recorded: readonly (readonly RecordedToolCall[])[];
}) {
  const candidate = replayTotals(
    rows.map((row) => row.candidate),
    recorded,
  );
  const baseline = compare
    ? replayTotals(
        rows.map((row) => row.baseline!),
        recorded,
      )
    : null;
  return (
    <div
      className={cn("grid gap-3 rounded-md bg-raised p-3", compare && "md:grid-cols-2")}
      aria-label="Totals"
    >
      {baseline ? <ArmTotalsView title="Baseline total" totals={baseline} /> : null}
      <ArmTotalsView title={compare ? "Candidate total" : "Total"} totals={candidate} />
    </div>
  );
}

function ArmTotalsView({ title, totals }: { title: string; totals: ReplayArmTotals }) {
  return (
    <p className="flex flex-wrap gap-3 text-ui text-fg-muted tabular-nums">
      <span className="font-medium text-fg">{title}</span>
      <span>
        {totals.turns} done{totals.failed > 0 ? `, ${totals.failed} failed` : ""}
      </span>
      <span className={totals.diverged > 0 ? "text-warning" : undefined}>
        {totals.diverged} diverged
      </span>
      <span>{formatInteger(totals.inputTokens + totals.outputTokens)} tokens</span>
      <span>{usd(totals.costUsd)}</span>
      <span>{formatDuration(totals.latencyMs)}</span>
    </p>
  );
}

function ended(arm: ReplayArmTurn): boolean {
  return arm.status !== "queued" && arm.status !== "running";
}

function metric(
  arm: ReplayArmTurn,
  show: (metrics: NonNullable<ReplayArmTurn["metrics"]>) => string,
): string {
  if (!arm.metrics) return arm.status === "ok" ? "…" : "–";
  return show(arm.metrics);
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function short(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "none");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
