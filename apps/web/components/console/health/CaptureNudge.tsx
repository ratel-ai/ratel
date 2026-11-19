"use client";

import { cn } from "@ratel/design-system/cn";
import { ChevronDown, LockKeyhole, ScanText } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import {
  CAPTURE_DIFF_LINES,
  type DiffLine,
  isNudgeSnoozed,
  nudgeTitle,
  otelCaptureDiffLines,
  readNudgeSnooze,
  snoozeNudge,
  subscribeToNudgeSnooze,
} from "@/components/console/health/capture-nudge-model";
import { track } from "@/lib/platform/track-client";
import type { CaptureLevel, CaptureUnlock, SourceMode } from "@/lib/readings/trace-signals/view";

export interface CaptureNudgeProps {
  projectId: string;
  captureLevel: CaptureLevel;
  /** The signals content capture would add, shown as ghost rows. */
  unlocks: readonly CaptureUnlock[];
  /**
   * `otel`: the project only sends OpenTelemetry, so the rows are the OTel
   * options still off (content, tool definitions, a conversation id), each
   * with what it adds, and the change is those options, not the Ratel SDK's.
   */
  mode?: SourceMode;
}

/**
 * "Turn on content capture to unlock 4 more signals".
 *
 * The signals it would add sit underneath as ghost rows, so the reader sees what
 * they are missing rather than being told. "Show me the change" opens the one
 * line their setup needs; "Not now" hides the nudge for 30 days on this browser
 * (a per-viewer convenience, so it lives in localStorage, and a browser that
 * refuses storage simply sees the nudge again next visit).
 */
export function CaptureNudge({
  projectId,
  captureLevel,
  unlocks,
  mode = "sdk",
}: CaptureNudgeProps) {
  const otel = mode === "otel";
  const [dismissed, setDismissed] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [tracked, setTracked] = useState(false);
  // Server and first client render agree on "not snoozed"; a snoozed browser
  // hides the nudge right after hydration.
  const snoozed = useSyncExternalStore(
    subscribeToNudgeSnooze,
    () => isNudgeSnoozed(readNudgeSnooze(projectId), Date.now()),
    () => false,
  );

  // OpenTelemetry has options beyond content, so captured content alone does not hide it.
  if ((!otel && captureLevel === "content") || unlocks.length === 0) return null;
  if (dismissed || snoozed) return null;

  const count = unlocks.length;
  const panelId = `capture-diff-${projectId}`;

  const toggleDiff = () => {
    const next = !showDiff;
    setShowDiff(next);
    if (next && !tracked) {
      setTracked(true);
      track("content_capture_enabled_from_nudge", {
        project_id: projectId,
        capture_level: captureLevel,
        unlock_count: count,
      });
    }
  };

  const notNow = () => {
    snoozeNudge(projectId, Date.now());
    setDismissed(true);
  };

  return (
    <section
      aria-labelledby="capture-nudge-title"
      data-capture-nudge="true"
      className="card-enter relative overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/30 p-4 sm:p-5"
      style={{ animationDelay: "60ms" }}
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-ctx-memory/35 bg-ctx-memory/10 text-ctx-memory">
          <ScanText className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="capture-nudge-title" className="text-sm font-semibold text-cream">
            {nudgeTitle(otel, count)}
          </h2>
          <p className="mt-1 text-pretty text-[13px] leading-5 text-warm-muted">
            {otel
              ? "Your traces already show which tools ran, which failed and how long they took. Each of these is one setting in your OpenTelemetry setup, and each adds something on its own."
              : "Your traces say which tools ran, not what was asked. With content capture on, Ratel also reads the asks and arguments, and these start working."}
          </p>
        </div>
      </div>

      <ul
        className="mt-4 grid gap-2 sm:grid-cols-2"
        aria-label={otel ? "What each option adds" : "Signals content capture adds"}
      >
        {unlocks.map((unlock) => (
          <li
            key={unlock.key}
            data-capture-unlock={unlock.key}
            className="flex items-start gap-2.5 rounded-lg border border-dashed border-forest-300 bg-base-deep/30 px-3 py-2.5"
          >
            <LockKeyhole className="mt-0.5 size-3.5 shrink-0 text-warm-muted" aria-hidden />
            <span className="min-w-0">
              <span className="block text-[13px] text-cream-dim">{unlock.label}</span>
              <span className="mt-0.5 block text-[12px] leading-5 text-warm-muted">
                {unlock.description}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggleDiff}
          aria-expanded={showDiff}
          aria-controls={panelId}
          className="inline-flex items-center gap-1.5 rounded-lg border border-forest-300 bg-base-deep/50 px-3 py-1.5 text-[13px] font-medium text-cream outline-none transition-colors hover:border-warm-muted/50 hover:bg-forest focus-visible:ring-2 focus-visible:ring-coral/60"
        >
          Show me the change
          <ChevronDown
            className={cn(
              "size-3.5 text-warm-muted transition-transform duration-300 motion-reduce:transition-none",
              showDiff && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        <button
          type="button"
          onClick={notNow}
          className="rounded-lg px-3 py-1.5 text-[13px] text-warm-muted outline-none transition-colors hover:text-cream focus-visible:ring-2 focus-visible:ring-coral/60"
        >
          Not now
        </button>
      </div>

      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
          showDiff ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div
          id={panelId}
          className="min-h-0 min-w-0 overflow-hidden"
          inert={!showDiff || undefined}
        >
          <CaptureDiff
            lines={
              otel ? otelCaptureDiffLines(unlocks.map((unlock) => unlock.key)) : CAPTURE_DIFF_LINES
            }
            otel={otel}
          />
        </div>
      </div>
    </section>
  );
}

/** The change, as a diff: one environment variable set before the SDK starts, or the OTel options still off. */
function CaptureDiff({ lines, otel }: { lines: readonly DiffLine[]; otel: boolean }) {
  return (
    <div className="pt-3" data-capture-diff="true">
      <div className="overflow-hidden rounded-lg border border-forest-300 bg-base-deep">
        <div className="border-b border-forest-300 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted">
          Where you set up tracing
        </div>
        <pre className="overflow-x-auto py-2 font-mono text-[12px] leading-6">
          {lines.map((line, index) => (
            <span
              key={index}
              className={cn("flex px-3", line.added ? "bg-green/10 text-cream" : "text-warm-muted")}
            >
              <span
                aria-hidden
                className={cn(
                  "w-4 shrink-0 select-none",
                  line.added ? "text-green" : "text-warm-muted",
                )}
              >
                {line.added ? "+" : " "}
              </span>
              <span className="whitespace-pre">{line.text}</span>
            </span>
          ))}
        </pre>
      </div>
      <p className="mt-2.5 text-[12px] leading-5 text-warm-muted">
        {otel
          ? "Names differ a little between instrumentations: OpenInference and Traceloop read session.id, for example."
          : "Using ratel-local? Set privacy to Tool details or Full content instead."}
      </p>
    </div>
  );
}
