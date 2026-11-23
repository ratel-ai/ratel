"use client";

import { cn } from "@ratel/design-system/cn";
import { useId } from "react";
import {
  CAPTURE_TOGGLE_LABEL,
  FIRST_READING_PROMISE,
  KEEP_BACK_NOTE,
  READ_SOURCES,
  RELAY_PRIVACY_LEVELS,
  type ReadSource,
} from "@/lib/console/onboarding/capture-consent";

/**
 * "What Ratel will read": the three ways telemetry reaches us, what each one
 * sends, and what reading it buys the customer, shown on the key reveal right
 * above the snippet it configures.
 *
 * Controlled rather than stateful: the key reveal owns the content-capture
 * choice because the snippet below reads it too, so flipping the switch here
 * rewrites the snippet in place. The switch starts off; content capture is
 * something a customer turns on, never something they find already on.
 */
export function CaptureConsentPanel({
  captureContent,
  onCaptureContentChange,
}: {
  captureContent: boolean;
  onCaptureContentChange: (next: boolean) => void;
}) {
  const headingId = useId();
  const toggleLabelId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-forest-300/70 bg-base-deep/35 p-4"
    >
      <h3 id={headingId} className="font-mono text-xs uppercase tracking-wide text-warm-muted">
        What Ratel will read
      </h3>

      <ul className="mt-3 divide-y divide-forest-300/50">
        {READ_SOURCES.map((source) => (
          <ReadSourceRow key={source.id} source={source} />
        ))}
      </ul>

      <p className="mt-1 text-pretty text-xs leading-relaxed text-warm-muted">{KEEP_BACK_NOTE}</p>

      <div className="mt-3 flex flex-col gap-3 border-t border-forest-300/50 pt-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={captureContent}
            aria-labelledby={toggleLabelId}
            onClick={() => onCaptureContentChange(!captureContent)}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral",
              captureContent ? "bg-coral" : "bg-forest-300",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "inline-block size-5 rounded-full bg-cream shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none",
                captureContent ? "translate-x-[22px]" : "translate-x-0.5",
              )}
            />
          </button>
          <span id={toggleLabelId} className="text-sm text-cream">
            {CAPTURE_TOGGLE_LABEL}
          </span>
        </div>
        <p className="font-mono text-[11px] leading-relaxed text-warm-muted">
          {FIRST_READING_PROMISE}
        </p>
      </div>
    </section>
  );
}

function ReadSourceRow({ source }: { source: ReadSource }) {
  return (
    <li
      data-read-source={source.id}
      className="grid gap-1.5 py-2.5 first:pt-0 md:grid-cols-[11rem_1fr] md:gap-4"
    >
      <div className="flex flex-wrap items-center gap-2 md:flex-col md:items-start md:gap-1">
        <span className="text-sm font-medium text-cream">{source.name}</span>
        <span className="rounded-full border border-forest-300 bg-base-deep/45 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-cream-dim">
          {source.status}
        </span>
      </div>
      <div className="space-y-1 text-pretty text-xs leading-relaxed text-warm-muted">
        <p>{source.sends}</p>
        {source.unlocks ? (
          <p>
            <span className="text-cream-dim">Unlocks: </span>
            {source.unlocks}
          </p>
        ) : (
          <ul aria-label="Privacy levels" className="flex flex-wrap gap-1.5 pt-0.5">
            {RELAY_PRIVACY_LEVELS.map((level) => (
              <li
                key={level}
                className="rounded-md border border-forest-300/70 px-1.5 py-0.5 font-mono text-[10px] text-cream-dim"
              >
                {level}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
