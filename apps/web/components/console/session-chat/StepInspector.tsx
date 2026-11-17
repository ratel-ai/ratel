"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button, IconButton } from "@ratel/design-system/button";
import { Checkbox } from "@ratel/design-system/checkbox";
import { cn } from "@ratel/design-system/cn";
import { Check, ChevronLeft, ChevronRight, Copy, ListTree, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { DecisionChip } from "@/components/console/session-replay/DecisionChip";
import { WhatIfPanel } from "@/components/console/session-replay/WhatIfPanel";
import { loadStepContentAction } from "@/lib/views/session-chat/actions";
import {
  type CallView,
  callDiff,
  type InspectMessage,
  type ToolTag,
  toolStepContent,
} from "@/lib/views/session-chat/inspect";
import type { StepContent, StepContentRequest } from "@/lib/views/session-chat/inspect-load";
import {
  type ChatCall,
  formatStepTime,
  type ProblemKind,
  type SessionChat,
  type TrackSegment,
} from "@/lib/views/session-chat/model";
import type { ChatPeek } from "@/lib/views/session-chat/peek";
import { LENS_PARTS, type LensPart } from "@/lib/views/session-replay/composition";
import { segmentTime } from "./format";
import type { ChatWhatIf } from "./SessionChatView";

/**
 * One step in the side panel (RC-284, A6, A7). A model call shows its tokens,
 * time, cost and context split, and, with the content opt-in on, what changed
 * since the call before it, its sections and the raw request with Copy. A
 * tool step shows why it was flagged, its arguments and result, and the call
 * that chose it; a search shows its query and ranked results. Text is read
 * on demand through `loadStepContentAction`, never with the opt-in off.
 * Each step shows its tool-choice verdicts, and a model call What if… when
 * the page gave it (RC-524: what the step-by-step view had).
 */

export interface StepInspectorProps {
  projectId: string;
  chat: SessionChat;
  segment: TrackSegment;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  whatIf?: ChatWhatIf;
  onOpen: (peek: ChatPeek) => void;
}

const PROBLEM_WORDS: Record<ProblemKind, string> = {
  failed: "Failed",
  retry: "Tried again after an error",
  loop: "Went in a loop",
  abandoned: "The person left before an answer",
};

const PART_LABELS: Record<LensPart, string> = {
  system: "System prompt",
  skills: "Skills",
  memory: "Memory",
  tools_used: "Tools it called",
  tools_unused: "Tools never called",
  history: "History",
  tool_results: "Tool results",
  user_input: "Their message",
};

const PART_CLASS: Record<LensPart, string> = {
  system: "bg-info",
  skills: "bg-success",
  memory: "bg-fg-muted",
  tools_used: "bg-line-active",
  tools_unused: "bg-warning",
  history: "bg-fg-faint",
  tool_results: "bg-line-strong",
  user_input: "bg-fg",
};

const TAG_WORDS: Record<ToolTag, string> = {
  called_here: "Called here",
  never_called: "Never called",
  new: "New",
};

export function StepInspector(props: StepInspectorProps) {
  const { chat, segment } = props;
  const verdicts = segment.stepIndex !== null ? (chat.verdicts?.[segment.stepIndex] ?? []) : [];
  return (
    <div className="flex flex-col gap-4">
      {verdicts.length > 0 ? (
        <section data-step-verdicts className="flex flex-col gap-1.5" aria-label="Tool choice">
          {verdicts.map((chip, i) => (
            <DecisionChip key={i} chip={chip} />
          ))}
        </section>
      ) : null}
      <StepBody {...props} />
    </div>
  );
}

function StepBody(props: StepInspectorProps) {
  const { segment } = props;
  if (segment.kind === "model_call") return <CallInspector {...props} />;
  if (segment.kind === "tool_call") return <ToolStep {...props} />;
  if (segment.kind === "search") return <SearchStep {...props} />;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-ui">
      <dt className="text-fg-subtle">Took</dt>
      <dd className="tabular-nums text-fg">{segmentTime(segment)}</dd>
    </dl>
  );
}

/** The model call's numbers and, with the opt-in on, its stored request. */
function CallInspector({
  projectId,
  chat,
  segment,
  follow,
  onFollowChange,
  whatIf,
  onOpen,
}: StepInspectorProps) {
  const at = chat.calls.findIndex((c) => c.stepIndex === segment.stepIndex);
  const call = chat.calls[at];
  const previous = at > 0 ? chat.calls[at - 1]! : null;
  const content = useStepContent(
    projectId,
    chat.textOff
      ? null
      : { eventIds: [call?.eventId, previous?.eventId].filter((id): id is string => !!id) },
  );
  const [tab, setTab] = useState<"structured" | "raw">("structured");
  if (!call) return <p className="text-ui text-fg-muted">This model call is not in the session.</p>;
  const split = chat.splits?.[call.stepIndex];
  const stored = content.data?.calls[call.eventId] ?? null;
  const before = previous ? (content.data?.calls[previous.eventId]?.view ?? null) : null;
  const sessionCalled = new Set(
    chat.segments.filter((s) => s.kind === "tool_call").map((s) => s.label),
  );
  const fork = chat.forks?.[call.stepIndex];
  return (
    <div data-call-inspector className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <IconButton
          label="Previous call"
          size="icon-sm"
          icon={<ChevronLeft />}
          disabled={!previous}
          onClick={() => previous && onOpen({ kind: "step", stepIndex: previous.stepIndex })}
        />
        <IconButton
          label="Next call"
          size="icon-sm"
          icon={<ChevronRight />}
          disabled={at >= chat.calls.length - 1}
          onClick={() => {
            const next = chat.calls[at + 1];
            if (next) onOpen({ kind: "step", stepIndex: next.stepIndex });
          }}
        />
        <span className="text-ui text-fg-muted tabular-nums">
          Call {call.callNumber} of {chat.calls.length}
        </span>
        <Checkbox
          className="ml-auto"
          checked={follow}
          onCheckedChange={onFollowChange}
          label="Follow the playhead"
        />
      </div>
      <CallNumbers call={call} />
      {split ? (
        <SplitBar split={split} />
      ) : (
        <p className="text-ui text-fg-subtle">No context split for this call.</p>
      )}
      {chat.textOff ? (
        <p data-text-off-note className="text-ui text-fg-muted">
          Message text is off for this project, so the inspector shows the numbers and the split
          only.
        </p>
      ) : content.error ? (
        <p className="text-ui text-danger">{content.error}</p>
      ) : !content.data ? (
        <p className="text-ui text-fg-subtle">Loading the request…</p>
      ) : !stored ? (
        <p className="text-ui text-fg-muted">The request of this call was not kept.</p>
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Request view"
            className="flex w-fit rounded-md border border-line"
          >
            {(["structured", "raw"] as const).map((key) => (
              <Button
                key={key}
                role="tab"
                aria-selected={tab === key}
                size="sm"
                variant="ghost"
                className={cn(
                  "rounded-none first:rounded-l-md last:rounded-r-md",
                  tab === key && "bg-selected text-fg",
                )}
                onClick={() => setTab(key)}
              >
                {key === "structured" ? "Structured" : "Raw request"}
              </Button>
            ))}
          </div>
          {tab === "raw" ? (
            <RawRequest raw={stored.raw} />
          ) : (
            <CallSections
              view={stored.view}
              previous={previous ? before : null}
              sessionCalled={sessionCalled}
            />
          )}
        </>
      )}
      {whatIf && fork ? (
        <div data-call-what-if>
          <WhatIfPanel
            key={call.stepIndex}
            projectId={whatIf.projectId}
            target={fork}
            options={whatIf.options}
            runs={whatIf.runs}
            readContent={whatIf.readContent}
          />
        </div>
      ) : null}
    </div>
  );
}

function CallNumbers({ call }: { call: ChatCall }) {
  const n = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US"));
  const items = [
    ["Input", `${n(call.inputTokens)} tokens`],
    ["Output", `${n(call.outputTokens)} tokens`],
    ["Took", call.latencyMs === null ? "not measured" : formatStepTime(call.latencyMs)],
    ["Cost", call.costUsd === null ? "—" : `$${call.costUsd.toFixed(4)}`],
  ] as const;
  return (
    <dl data-call-numbers className="grid grid-cols-4 gap-3">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-fg-subtle">{label}</dt>
          <dd className="text-ui tabular-nums text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SplitBar({ split }: { split: NonNullable<SessionChat["splits"]>[number] }) {
  const total = LENS_PARTS.reduce((sum, part) => sum + split.parts[part], 0);
  const parts = LENS_PARTS.filter((part) => split.parts[part] > 0);
  if (total === 0) return <p className="text-ui text-fg-subtle">No context split for this call.</p>;
  return (
    <section data-call-split>
      <div className="mb-2 flex h-2 gap-px overflow-hidden rounded-full">
        {parts.map((part) => (
          <span
            key={part}
            className={PART_CLASS[part]}
            style={{ width: `${(split.parts[part] / total) * 100}%` }}
          />
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {parts.map((part) => (
          <div key={part} className="flex items-center gap-1.5">
            <dt className="flex flex-1 items-center gap-1.5 text-fg-muted">
              <span aria-hidden className={cn("size-2 rounded-sm", PART_CLASS[part])} />
              {PART_LABELS[part]}
            </dt>
            <dd className="tabular-nums text-fg">
              {split.parts[part].toLocaleString("en-US")} ·{" "}
              {Math.round((split.parts[part] / total) * 100)}%
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The call's sections, with what changed since the call before (a first call has everything new). */
export function CallSections({
  view,
  previous,
  sessionCalled,
}: {
  view: CallView;
  previous: CallView | null;
  sessionCalled: ReadonlySet<string>;
}) {
  const diff = callDiff(previous, view, sessionCalled);
  const newAt = new Set(diff.newMessages);
  return (
    <div data-call-sections className="flex flex-col gap-1">
      <p data-call-diff className="mb-2 text-ui text-fg-muted">
        {diff.firstCall ? diff.summary : `Since the last call: ${diff.summary}`}
      </p>
      <Section
        title="System prompt"
        meta={view.system ? `${view.system.length.toLocaleString("en-US")} characters` : "none"}
      >
        {view.system ? <Pre>{view.system}</Pre> : null}
      </Section>
      <Section title="Skills" meta={`${view.skills.length} loaded`}>
        {view.skills.length > 0 ? (
          <p className="font-mono text-xs text-fg">{view.skills.join(", ")}</p>
        ) : null}
      </Section>
      <Section title="Tools" meta={`${view.tools.length} loaded`}>
        <ul className="flex flex-col gap-1">
          {diff.tools.map((tool) => (
            <li
              key={tool.name}
              data-tool={tool.name}
              className="flex flex-wrap items-center gap-1.5 text-ui"
            >
              <span className="font-mono text-xs text-fg">{tool.name}</span>
              {tool.tags.map((tag) => (
                <Badge key={tag} tone={tag === "never_called" ? "warning" : "neutral"}>
                  {TAG_WORDS[tag]}
                </Badge>
              ))}
            </li>
          ))}
        </ul>
      </Section>
      <Section
        title="Messages"
        meta={`${view.messages.length} · ${diff.newMessages.length} new`}
        defaultOpen
      >
        <ol className="flex flex-col gap-2">
          {view.messages.map((message, i) => (
            <MessageItem key={i} message={message} isNew={newAt.has(i)} />
          ))}
        </ol>
      </Section>
      <Section
        title="What came back"
        meta={
          view.output.length > 0
            ? `${view.output.length} ${view.output.length === 1 ? "message" : "messages"}`
            : "not kept"
        }
      >
        <ol className="flex flex-col gap-2">
          {view.output.map((message, i) => (
            <MessageItem key={i} message={message} isNew={false} />
          ))}
        </ol>
      </Section>
      <Section
        title="Settings"
        meta={view.settings ? `${Object.keys(view.settings).length} kept` : "not kept"}
      >
        {view.settings ? <Pre>{JSON.stringify(view.settings, null, 2)}</Pre> : null}
      </Section>
    </div>
  );
}

function MessageItem({ message, isNew }: { message: InspectMessage; isNew: boolean }) {
  const who =
    message.role === "user"
      ? "Their message"
      : message.role === "tool"
        ? "Tool result"
        : message.role === "assistant"
          ? "Agent"
          : message.role;
  return (
    <li
      data-message={message.role}
      data-new={isNew || undefined}
      className="border-l-2 border-line pl-2"
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs text-fg-subtle">
        {who}
        {isNew ? <Badge tone="info">New</Badge> : null}
      </div>
      {message.text ? (
        <p className="whitespace-pre-wrap break-words text-ui text-fg">{message.text}</p>
      ) : null}
      {message.toolCalls.map((c, i) => (
        <div key={i} className="mt-1">
          <p className="text-xs text-fg-subtle">
            Called <span className="font-mono">{c.name}</span>
          </p>
          <Pre>{JSON.stringify(c.arguments, null, 2)}</Pre>
        </div>
      ))}
    </li>
  );
}

/** The stored payload as it is (Q7: no provider re-format), with Copy. */
export function RawRequest({ raw }: { raw: unknown }) {
  const text = JSON.stringify(raw, null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <div data-raw-request className="flex flex-col gap-2">
      <Button
        size="sm"
        className="self-start"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </Button>
      <Pre>{text}</Pre>
    </div>
  );
}

/** A tool step: why it was flagged, its arguments and result, and the call that chose it. */
function ToolStep({ projectId, chat, segment, onOpen }: StepInspectorProps) {
  const turnCalls = chat.calls.filter((c) => c.turnIndex === segment.turnIndex);
  const chooser =
    [...turnCalls].reverse().find((c) => c.stepIndex < (segment.stepIndex ?? 0)) ?? null;
  const after = turnCalls.find((c) => c.stepIndex > (segment.stepIndex ?? 0)) ?? null;
  const content = useStepContent(
    projectId,
    chat.textOff
      ? null
      : { eventIds: [chooser?.eventId, after?.eventId].filter((id): id is string => !!id) },
  );
  const stored = content.data
    ? toolStepContent(
        segment.label,
        chooser ? (content.data.calls[chooser.eventId]?.view ?? null) : null,
        after ? (content.data.calls[after.eventId]?.view ?? null) : null,
      )
    : null;
  return (
    <div data-tool-step className="flex flex-col gap-4">
      <StepFacts chat={chat} segment={segment} />
      {chat.textOff ? (
        <p data-text-off-note className="text-ui text-fg-muted">
          Message text is off for this project, so arguments and results are not shown.
        </p>
      ) : (
        <>
          <Block title="Arguments">
            {stored ? (
              stored.arguments !== null ? (
                <Pre>{JSON.stringify(stored.arguments, null, 2)}</Pre>
              ) : (
                <Missing />
              )
            ) : (
              <Loading error={content.error} />
            )}
          </Block>
          <Block title="Result">
            {stored ? (
              stored.result !== null ? (
                <Pre>{stored.result}</Pre>
              ) : (
                <Missing />
              )
            ) : (
              <Loading error={content.error} />
            )}
          </Block>
        </>
      )}
      {chooser ? (
        <Button
          size="sm"
          className="self-start"
          onClick={() => onOpen({ kind: "step", stepIndex: chooser.stepIndex })}
        >
          <ListTree aria-hidden />
          See what the model had when it chose this
        </Button>
      ) : null}
    </div>
  );
}

/** A search: its query (opt-in on) and its ranked results. */
function SearchStep({ projectId, chat, segment }: StepInspectorProps) {
  const content = useStepContent(
    projectId,
    chat.textOff ? null : { eventIds: [], searchEventId: segment.eventId },
  );
  return (
    <div data-search-step className="flex flex-col gap-4">
      <StepFacts chat={chat} segment={segment} />
      <Block title="Query">
        {chat.textOff ? (
          <p className="text-ui text-fg-muted">Message text is off for this project.</p>
        ) : content.data ? (
          content.data.query ? (
            <Pre>{content.data.query}</Pre>
          ) : (
            <Missing />
          )
        ) : (
          <Loading error={content.error} />
        )}
      </Block>
      <Block title="Ranked results">
        {segment.hits.length > 0 ? (
          <ol className="flex flex-col gap-0.5 text-ui">
            {segment.hits.map((hit, i) => (
              <li key={`${hit}-${i}`} className="flex gap-2">
                <span className="w-5 text-right tabular-nums text-fg-subtle">{i + 1}</span>
                <span className="font-mono text-xs text-fg">{hit}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-ui text-fg-muted">No result was kept.</p>
        )}
      </Block>
    </div>
  );
}

function StepFacts({ chat, segment }: { chat: SessionChat; segment: TrackSegment }) {
  const problem = chat.problems.find((p) => p.stepIndex === segment.stepIndex);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-ui">
      <dt className="text-fg-subtle">Took</dt>
      <dd className="tabular-nums text-fg">{segmentTime(segment)}</dd>
      <dt className="text-fg-subtle">Status</dt>
      <dd className="text-fg">
        {problem ? (
          <span className="inline-flex items-center gap-1.5">
            <TriangleAlert aria-hidden className="size-3.5 text-warning" />
            {problem.kinds.map((kind) => PROBLEM_WORDS[kind]).join(", ")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <Check aria-hidden className="size-3.5 text-success" />
            Nothing to check
          </span>
        )}
      </dd>
    </dl>
  );
}

function Section({
  title,
  meta,
  defaultOpen = false,
  children,
}: {
  title: string;
  meta: string;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  return (
    <details open={defaultOpen} data-section={title} className="group border-b border-line py-2">
      <summary className="flex cursor-pointer items-center gap-2 text-ui outline-none select-none focus-visible:ring-2 focus-visible:ring-focus">
        <ChevronRight
          aria-hidden
          className="size-3.5 text-fg-subtle transition-transform group-open:rotate-90"
        />
        <span className="font-medium text-fg">{title}</span>
        <span className="tabular-nums text-fg-subtle">{meta}</span>
      </summary>
      {children ? <div className="mt-2 pl-5">{children}</div> : null}
    </details>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-ui font-medium text-fg">{title}</h3>
      {children}
    </section>
  );
}

function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-line bg-app p-2 font-mono text-xs whitespace-pre-wrap break-words text-fg">
      {children}
    </pre>
  );
}

function Missing() {
  return <p className="text-ui text-fg-muted">Not kept for this step.</p>;
}

function Loading({ error }: { error: string | null }) {
  return error ? (
    <p className="text-ui text-danger">{error}</p>
  ) : (
    <p className="text-ui text-fg-subtle">Loading…</p>
  );
}

/** The stored text behind a view, read on demand; a null request reads nothing. */
function useStepContent(
  projectId: string,
  request: StepContentRequest | null,
): { data: StepContent | null; error: string | null } {
  const key = request ? JSON.stringify(request) : null;
  const [state, setState] = useState<{
    key: string | null;
    data: StepContent | null;
    error: string | null;
  }>({ key: null, data: null, error: null });
  useEffect(() => {
    if (!key) return;
    let live = true;
    loadStepContentAction(projectId, JSON.parse(key) as StepContentRequest).then(
      (result) => {
        if (!live) return;
        setState(
          result.ok
            ? {
                key,
                data: result.content,
                error: result.content ? null : "Message text is off for this project.",
              }
            : { key, data: null, error: result.error },
        );
      },
      () =>
        live && setState({ key, data: null, error: "This step could not be loaded. Try again." }),
    );
    return () => {
      live = false;
    };
  }, [projectId, key]);
  return state.key === key ? { data: state.data, error: state.error } : { data: null, error: null };
}
