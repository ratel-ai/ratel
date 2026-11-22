"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Textarea } from "@ratel/design-system/input";
import { Check, Pencil, Pin, Shuffle, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import type { ToolCallView } from "@/lib/views/sandboxes/playground-state";
import { canPin, type ToolBadge, toolBadge } from "@/lib/views/sandboxes/tools-state";

export type ConfirmDecision = "approve" | "edit" | "fake" | "reject";
/** ok: the run takes the decision. decided: someone decided first (409). failed: nothing was sent. */
export type SendOutcome = "ok" | "decided" | "failed";

export interface ToolCardProps {
  call: ToolCallView;
  /** The value the Fake editor starts with (a skeleton of the tool's output schema). */
  fakeSkeleton: unknown;
  /** Sends a decision on a confirm call. Absent on a turn that has ended. */
  onConfirm?: (decision: ConfirmDecision, value?: unknown) => Promise<SendOutcome>;
  /** Pins the call's result in the session. Absent when there is no session. */
  onPin?: () => Promise<boolean>;
}

const BADGE_TONE: Record<ToolBadge, Tone> = {
  real: "info",
  fake·recorded: "neutral",
  fake·generated: "neutral",
  fake·pinned: "neutral",
  confirmed: "success",
  rejected: "danger",
  pending: "neutral",
  "awaiting review": "warning",
};

/**
 * One tool call inside an assistant turn: the tool, how it was answered (its
 * mode badge), its arguments and its result. A confirm call the run is paused
 * on asks the reviewer to approve, edit, fake or reject it. A finished fake
 * can be pinned, so later calls with the same arguments get the same value.
 */
export function ToolCard({ call, fakeSkeleton, onConfirm, onPin }: ToolCardProps) {
  const badge = toolBadge(call);
  const review = badge === "awaiting review" && onConfirm !== undefined;

  return (
    <article
      aria-label={`Tool call ${call.tool}`}
      className={cn(
        "flex flex-col gap-1 rounded-lg border bg-rail px-3 py-2",
        review ? "border-warning" : "border-line",
      )}
    >
      <header className="flex min-h-7 items-center gap-2">
        <code translate="no" className="truncate font-mono text-xs text-fg">
          {call.tool}
        </code>
        <Badge tone={BADGE_TONE[badge]}>
          {badge === "fake·pinned" ? <Pin aria-hidden /> : null}
          {badge}
        </Badge>
        {call.done && call.isError ? (
          <span className="text-xs text-danger">Returned an error</span>
        ) : null}
        {onPin && canPin(call) ? <PinButton onPin={onPin} /> : null}
      </header>
      {/* Keyed on review: Collapsible reads defaultOpen only once, so the card remounts it when review ends. */}
      <JsonDisclosure
        key={review ? "review" : "done"}
        title="Arguments"
        value={call.args}
        defaultOpen={review}
      />
      {call.done ? (
        <JsonDisclosure
          title="Result"
          value={call.result}
          tone={call.isError ? "danger" : undefined}
        />
      ) : null}
      {review ? (
        <ConfirmActions args={call.args} fakeSkeleton={fakeSkeleton} onConfirm={onConfirm} />
      ) : null}
    </article>
  );
}

function PinButton({ onPin }: { onPin: () => Promise<boolean> }) {
  const [state, setState] = useState<"idle" | "pinning" | "pinned" | "failed">("idle");
  async function pin() {
    setState("pinning");
    setState((await onPin()) ? "pinned" : "failed");
  }
  return (
    <span className="ml-auto inline-flex items-center gap-2">
      {state === "failed" ? (
        <span className="text-xs text-danger">Couldn&apos;t pin. Try again.</span>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void pin()}
        disabled={state === "pinned"}
        loading={state === "pinning"}
      >
        {state === "pinned" ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Pin className="size-3.5" aria-hidden />
        )}
        {state === "pinned" ? "Pinned" : state === "pinning" ? "Pinning…" : "Pin this result"}
      </Button>
    </span>
  );
}

/** The four decisions on a paused confirm call. Edit and Fake open a JSON editor first. */
function ConfirmActions({
  args,
  fakeSkeleton,
  onConfirm,
}: {
  args: unknown;
  fakeSkeleton: unknown;
  onConfirm: (decision: ConfirmDecision, value?: unknown) => Promise<SendOutcome>;
}) {
  const editorId = useId();
  const [editor, setEditor] = useState<"edit" | "fake" | null>(null);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [posting, setPosting] = useState<ConfirmDecision | null>(null);
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);
  const closed = outcome === "ok" || outcome === "decided";
  const busy = posting !== null || closed;

  function open(kind: "edit" | "fake") {
    setEditor(kind);
    setDraft(JSON.stringify(kind === "edit" ? args : fakeSkeleton, null, 2));
    setDraftError(null);
  }

  async function send(decision: ConfirmDecision) {
    let value: unknown;
    if (decision === "edit" || decision === "fake") {
      try {
        value = JSON.parse(draft);
      } catch {
        setDraftError("This is not valid JSON.");
        return;
      }
    }
    setPosting(decision);
    const result = await onConfirm(decision, value);
    setPosting(null);
    setOutcome(result);
    if (result !== "failed") setEditor(null);
  }

  if (closed) {
    return (
      <p className="py-1 text-xs text-fg-muted" aria-live="polite">
        {outcome === "ok" ? "Decision sent. The run continues…" : "This call was already decided."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 pt-1">
      {editor ? (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-fg-muted" htmlFor={editorId}>
            {editor === "edit" ? "Arguments to run with (JSON)" : "Value to return (JSON)"}
          </label>
          <Textarea
            id={editorId}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setDraftError(null);
            }}
            aria-invalid={draftError ? true : undefined}
            spellCheck={false}
            className="min-h-32 font-mono text-xs"
          />
          {draftError ? <p className="text-xs text-danger">{draftError}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => void send(editor)}
              loading={posting === editor}
              disabled={busy}
            >
              {editor === "edit" ? "Approve with these arguments" : "Return this value"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditor(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <DecisionButton
            icon={<Check aria-hidden />}
            pending={posting === "approve"}
            disabled={busy}
            onClick={() => void send("approve")}
          >
            Approve
          </DecisionButton>
          <DecisionButton
            icon={<Pencil aria-hidden />}
            disabled={busy}
            onClick={() => open("edit")}
          >
            Edit and approve
          </DecisionButton>
          <DecisionButton
            icon={<Shuffle aria-hidden />}
            disabled={busy}
            onClick={() => open("fake")}
          >
            Fake
          </DecisionButton>
          <DecisionButton
            icon={<X aria-hidden />}
            pending={posting === "reject"}
            disabled={busy}
            onClick={() => void send("reject")}
          >
            Reject
          </DecisionButton>
        </div>
      )}
      {outcome === "failed" ? (
        <p className="text-xs text-danger">Couldn&apos;t send the decision. Try again.</p>
      ) : null}
    </div>
  );
}

function DecisionButton({
  icon,
  pending = false,
  disabled,
  onClick,
  children,
}: {
  icon: ReactNode;
  pending?: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button size="sm" onClick={onClick} loading={pending} disabled={disabled}>
      {pending ? null : icon}
      {children}
    </Button>
  );
}

function JsonDisclosure({
  title,
  value,
  defaultOpen = false,
  tone,
}: {
  title: string;
  value: unknown;
  defaultOpen?: boolean;
  tone?: "danger";
}) {
  return (
    <Disclosure title={title} defaultOpen={defaultOpen}>
      <pre
        tabIndex={0}
        className={cn(
          "max-h-72 overflow-auto rounded-md border border-line bg-app p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap break-words outline-none focus-visible:ring-2 focus-visible:ring-focus",
          tone === "danger" ? "text-danger" : "text-fg",
        )}
      >
        {JSON.stringify(value, null, 2) ?? "null"}
      </pre>
    </Disclosure>
  );
}
