"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Textarea } from "@ratel/design-system/input";
import { Kbd } from "@ratel/design-system/kbd";
import { Callout } from "@ratel/design-system/states";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { SessionChatView } from "@/components/console/session-chat/SessionChatView";
import type { ToolAnswerSource } from "@/lib/views/eval-gate/types";
import {
  continueFromStepAction,
  editReplyAction,
  simulateSpecAgainAction,
  simulateStepAgainAction,
} from "@/lib/views/evals/actions";
import {
  type EvalChat,
  type EvalChatItem,
  type EvalChatResult,
  evalChat,
  evalStepSource,
} from "@/lib/views/evals/domain/chat";
import { EVAL_TRANSCRIPT_TTL_DAYS, type EvalResult } from "@/lib/views/evals/domain/types";
import { evalHref } from "@/lib/views/evals/paths";
import { REASON_TEXT, SOURCE_LABELS, SOURCE_RULES } from "@/lib/views/evals/test-view";
import type { TrackSegment } from "@/lib/views/session-chat/model";
import { GeneratedMark } from "./marks";

const SOURCE_TONE: Record<ToolAnswerSource, Tone> = {
  recorded: "neutral",
  composed: "info",
  earlier: "neutral",
  "stand-in": "warning",
  mock: "info",
};
const DIFFERS = "Runs differ from here";

type StepActionResult =
  | { ok: true; value: { run: { id: string }; item: { id: string } } }
  | { ok: false; error: string };

export interface EvalRunReplayProps {
  projectId: string;
  evalId: string;
  runId: string;
  item: EvalChatItem;
  result: EvalChatResult;
  /** The eval's completed result before this run: the track marks where they differ. */
  previous?: Pick<EvalResult, "transcript" | "toolAnswers"> | null;
}

/**
 * RC-648: an eval run in the session replay of Traces (`SessionChatView`,
 * synced): the same chat, track, playhead, keys and inspector. The text comes
 * from the run's transcript (`evalStepSource`), and the inspector keeps the
 * eval's actions: on the first model call, edit the system prompt or the
 * message; on a tool call, set its answer; then Simulate again, which opens
 * the new run. Continue from here copies the eval with the steps so far.
 * RC-654: on an agent step, Edit reply changes its text and tool calls and
 * runs this eval, or a copy, from that reply.
 */
export function EvalRunReplay({
  projectId,
  evalId,
  runId,
  item,
  result,
  previous = null,
}: EvalRunReplayProps) {
  const model = useMemo(() => evalChat(item, result, previous), [item, result, previous]);
  const source = useMemo(() => (model ? evalStepSource(model) : undefined), [model]);
  if (!model) return null;
  const firstCall = model.chat.calls[0]?.stepIndex ?? null;
  return (
    <div className="flex flex-col gap-2" data-eval-run-replay>
      <SessionChatView
        projectId={projectId}
        chat={model.chat}
        settingsHref={`/project/${encodeURIComponent(projectId)}/settings`}
        synced
        source={source}
        traceLinks={false}
        marker={
          model.differsAt !== null ? { stepIndex: model.differsAt, label: DIFFERS } : undefined
        }
        inspectorActions={(segment) => (
          <StepActions
            key={segment.stepIndex}
            projectId={projectId}
            evalId={evalId}
            runId={runId}
            item={item}
            result={result}
            model={model}
            segment={segment}
            first={segment.stepIndex === firstCall}
          />
        )}
      />
      <p className="text-xs text-fg-subtle">
        <Kbd>←</Kbd> <Kbd>→</Kbd> move one step, <Kbd>Space</Kbd> plays, <Kbd>Esc</Kbd> closes the
        inspector. Eval run text expires after {EVAL_TRANSCRIPT_TTL_DAYS} days.
      </p>
    </div>
  );
}

function StepActions({
  projectId,
  evalId,
  runId,
  item,
  result,
  model,
  segment,
  first,
}: {
  projectId: string;
  evalId: string;
  runId: string;
  item: EvalChatItem;
  result: EvalChatResult;
  model: EvalChat;
  segment: TrackSegment;
  first: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const step = segment.stepIndex !== null ? model.steps[segment.stepIndex] : undefined;
  const transcriptStep = step ? result.transcript?.steps[step.transcriptIndex] : undefined;
  const answer = transcriptStep?.role === "tool" ? transcriptStep.content : null;
  const [system, setSystem] = useState(item.systemPrompt ?? "");
  const [message, setMessage] = useState(item.message);
  const [draft, setDraft] = useState(answer ?? "");
  if (!step) return null;

  const generated = new Set(model.generated);
  const specChange = first
    ? {
        ...(system.trim() !== (item.systemPrompt ?? "").trim() ? { systemPrompt: system } : {}),
        ...(message.trim() !== item.message.trim() ? { message } : {}),
      }
    : {};
  const changed =
    step.role === "tool"
      ? answer !== null && draft.trim() !== answer.trim()
      : Object.keys(specChange).length > 0;
  const act = (work: () => Promise<StepActionResult>, title: string, copy: boolean) =>
    start(async () => {
      setError(null);
      const done = await work();
      if (!done.ok) {
        setError(done.error);
        return;
      }
      toast({ title });
      router.push(
        evalHref(projectId, copy ? done.value.item.id : evalId, { run: done.value.run.id }),
      );
    });
  const simulateAgain = () =>
    act(
      () =>
        step.role === "tool"
          ? simulateStepAgainAction(projectId, { evalId, runId, step: step.transcriptIndex }, draft)
          : simulateSpecAgainAction(projectId, evalId, specChange),
      "Saved. The eval is running again.",
      false,
    );
  const continueHere = () =>
    act(
      () => continueFromStepAction(projectId, { evalId, runId, step: step.transcriptIndex }),
      "Copied. The new eval is running.",
      true,
    );
  const editable = step.role === "tool" ? answer !== null : first;

  return (
    <section
      aria-label="Eval actions"
      className="flex flex-col gap-3 border-t border-line pt-4"
      data-eval-step-actions={step.role}
    >
      {segment.stepIndex === model.differsAt ? (
        <p data-differ className="flex items-center gap-2 text-xs text-info">
          {DIFFERS}
          <span aria-hidden className="h-px flex-1 border-t border-dashed border-info/60" />
        </p>
      ) : null}
      {step.role === "tool" && step.answer ? (
        <div className="flex flex-col gap-1.5" data-answer-source={step.answer.source}>
          <span className="flex items-center gap-2 text-ui text-fg">
            Answer from{" "}
            <Badge tone={SOURCE_TONE[step.answer.source]}>
              {SOURCE_LABELS[step.answer.source]}
            </Badge>
          </span>
          <p
            className={
              step.answer.source === "stand-in" ? "text-ui text-warning" : "text-ui text-fg-muted"
            }
          >
            {SOURCE_RULES[step.answer.source]}
          </p>
          <p className="text-ui text-fg">
            {REASON_TEXT[step.answer.reason]}
            {step.answer.why ? ` Why: ${step.answer.why}` : ""}
          </p>
        </div>
      ) : null}
      {first ? (
        <>
          <SpecField
            label="System prompt"
            generated={generated.has("systemPrompt")}
            value={system}
            onChange={setSystem}
            placeholder="None of its own: a recorded run uses the recorded prompt. Write one to replace it."
          />
          <SpecField
            label="Message"
            generated={generated.has("message")}
            value={message}
            onChange={setMessage}
          />
          {generated.has("tools") ? (
            <p className="flex items-center gap-2 text-ui text-fg-muted">
              Tools <GeneratedMark />
            </p>
          ) : null}
        </>
      ) : null}
      {step.role === "tool" && answer !== null ? (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-subtle">Answer</span>
          <Textarea
            aria-label="Answer"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-24 font-mono text-xs"
          />
        </label>
      ) : null}
      {transcriptStep?.role === "assistant" && !result.turns?.length ? (
        <EditReply
          key={step.transcriptIndex}
          initial={transcriptStep}
          pending={pending}
          onRun={(reply, target) =>
            act(
              () =>
                editReplyAction(
                  projectId,
                  { evalId, runId, step: step.transcriptIndex },
                  reply,
                  target,
                ),
              target === "copy"
                ? "Copied. The copy runs from your reply."
                : "Saved. The eval runs from your reply.",
              target === "copy",
            )
          }
          onError={setError}
        />
      ) : null}
      {error ? (
        <Callout tone="danger" title="Not saved">
          {error}
        </Callout>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={continueHere}
          data-continue
        >
          Continue from here
        </Button>
        {editable ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            loading={pending}
            disabled={!changed}
            onClick={simulateAgain}
            data-simulate-again
          >
            Simulate again
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function SpecField({
  label,
  generated,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  generated: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-xs text-fg-subtle">
        {label}
        {generated ? <GeneratedMark /> : null}
      </span>
      {generated ? (
        <span className="text-ui text-warning">
          A model wrote this: the recording did not have it. Change it to match your agent.
        </span>
      ) : null}
      <Textarea
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-h-20"
      />
    </label>
  );
}

type ReplyTarget = "this" | "copy";

/** RC-654: the agent reply of one step, edited: its text and its tool calls as JSON. The run goes on from it, on this eval or a copy. */
export function EditReply({
  initial,
  pending,
  onRun,
  onError,
  defaultOpen = false,
}: {
  initial: { text: string; calls: { name: string; args: Record<string, unknown> }[] };
  pending: boolean;
  defaultOpen?: boolean;
  onRun: (
    reply: { text: string; calls: { name: string; args: Record<string, unknown> }[] },
    target: ReplyTarget,
  ) => void;
  onError: (error: string | null) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState(initial.text);
  const [calls, setCalls] = useState(() => JSON.stringify(initial.calls, null, 2));
  const [target, setTarget] = useState<ReplyTarget>("this");
  if (!open) {
    return (
      <div className="flex justify-end">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setOpen(true)}
          data-edit-reply
        >
          Edit reply
        </Button>
      </div>
    );
  }
  const run = () => {
    let parsed: unknown;
    try {
      parsed = calls.trim() ? JSON.parse(calls) : [];
    } catch {
      onError(
        'The tool calls are not valid JSON. Write a list like [{"name": "tool", "args": {}}].',
      );
      return;
    }
    if (!Array.isArray(parsed)) {
      onError("The tool calls must be a JSON list.");
      return;
    }
    onError(null);
    onRun({ text, calls: parsed as { name: string; args: Record<string, unknown> }[] }, target);
  };
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-3" data-reply-editor>
      <span className="text-ui font-medium text-fg">Edit reply</span>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-fg-subtle">Reply text</span>
        <Textarea
          aria-label="Reply text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="min-h-20"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-fg-subtle">
          Tool calls (JSON). The new run answers them. With no calls, the run ends with this reply.
        </span>
        <Textarea
          aria-label="Tool calls"
          value={calls}
          onChange={(event) => setCalls(event.target.value)}
          className="min-h-24 font-mono text-xs"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-fg-subtle">Run on</span>
        <SegmentedControl
          label="Run on"
          value={target}
          onValueChange={setTarget}
          options={[
            { value: "this", label: "This eval" },
            { value: "copy", label: "A copy" },
          ]}
        />
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          loading={pending}
          onClick={run}
          data-run-from-reply
        >
          Run from this reply
        </Button>
      </div>
    </div>
  );
}
