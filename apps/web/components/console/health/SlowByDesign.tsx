"use client";

import { cn } from "@ratel/design-system/cn";
import { EyeOff, RotateCcw } from "lucide-react";
import { useState, useTransition } from "react";
import {
  dismissSlowSignalAction,
  restoreSignalAction,
  type SignalActionResult,
} from "@/app/(console)/project/[projectId]/health/signal-actions";
import { useSharedSurface } from "@/components/console/health/surface";
import { type DismissedSignal, isDismissable } from "@/lib/readings/trace-signals/dismiss";
import type { SignalView } from "@/lib/readings/trace-signals/view";

const BUTTON =
  "inline-flex items-center gap-1.5 rounded-full border border-forest-300 px-2.5 py-0.5 text-[12px] leading-5 text-cream-dim outline-none transition-colors hover:border-cream/40 hover:text-cream focus-visible:ring-2 focus-visible:ring-coral/60 disabled:cursor-wait disabled:opacity-60";

/**
 * Runs a status change; keeps the error to show beside the button. The action
 * revalidates the page, so a success comes back as the re-read page.
 */
function useSignalAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<SignalActionResult>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.message);
    });
  };
  return { pending, error, run };
}

/**
 * On an opened slow-tool problem: hide it because the tool is slow by design
 * (a render, a deploy, a wait on a job). Never on a shared page, and only for
 * the kinds that can be hidden.
 */
export function SlowByDesignButton(props: {
  projectId: string;
  signal: SignalView;
  className?: string;
}) {
  const shared = useSharedSurface();
  if (shared || !isDismissable(props.signal.kind)) return null;
  return <HideButton {...props} />;
}

function HideButton({
  projectId,
  signal,
  className,
}: {
  projectId: string;
  signal: SignalView;
  className?: string;
}) {
  const { pending, error, run } = useSignalAction();
  const tool = signal.subject.chips[0]?.label ?? signal.subject.label;
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2 pb-3", className)}
      data-slow-by-design={signal.id}
    >
      <button
        type="button"
        className={BUTTON}
        disabled={pending}
        onClick={() => run(() => dismissSlowSignalAction(projectId, signal.id))}
      >
        <EyeOff className="size-3.5" aria-hidden />
        {pending ? "Hiding…" : "Slow by design, hide it"}
      </button>
      <span className="text-[12px] text-warm-muted">
        {error ?? `For tools like ${tool} whose work takes this long. You can show it again below.`}
      </span>
    </div>
  );
}

/** Under the problem list: the slow tools hidden as slow by design, each with "Show again". */
export function DismissedLine(props: { projectId: string; dismissed: readonly DismissedSignal[] }) {
  const shared = useSharedSurface();
  if (shared || props.dismissed.length === 0) return null;
  return <Dismissed {...props} />;
}

function Dismissed({
  projectId,
  dismissed,
}: {
  projectId: string;
  dismissed: readonly DismissedSignal[];
}) {
  const { pending, error, run } = useSignalAction();
  return (
    <div
      data-signals-dismissed={dismissed.length}
      className="mx-3 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 text-[13px] text-warm-muted sm:mx-4"
    >
      <span>Hidden as slow by design:</span>
      {dismissed.map((item) => (
        <span key={item.id} className="inline-flex items-center gap-1.5">
          <span className="text-cream-dim">{item.label}</span>
          <button
            type="button"
            className={cn(BUTTON, "px-2 py-0")}
            disabled={pending}
            onClick={() => run(() => restoreSignalAction(projectId, item.id))}
            aria-label={`Show ${item.label} again`}
          >
            <RotateCcw className="size-3" aria-hidden />
            Show again
          </button>
        </span>
      ))}
      {error && (
        <span role="alert" className="text-coral">
          {error}
        </span>
      )}
    </div>
  );
}
