"use client";

import { cn } from "@ratel/design-system/cn";
import { Activity, Clock, Laptop, type LucideIcon, MessagesSquare } from "lucide-react";
import { useId } from "react";
import {
  CAPTURE_TOGGLE_LABEL,
  CAPTURE_TOGGLE_NOTE,
  FIRST_READING_PROMISE,
  KEEP_BACK_NOTE,
  READ_SOURCES,
  RELAY_PRIVACY_LEVELS,
  type ReadSource,
  type ReadSourceId,
} from "@/lib/console/onboarding/capture-consent";

const SOURCE_ICON: Record<ReadSourceId, LucideIcon> = {
  "runtime-events": Activity,
  "content-capture": MessagesSquare,
  "local-relay": Laptop,
};

/**
 * "What Ratel will read": the three ways telemetry reaches us, what each one
 * sends, and what reading it buys the customer. On the key reveal it is the
 * side column next to the prompt and the snippets it configures.
 *
 * Each source leads with what leaves the customer's process; what reading it
 * unlocks sits one click down, so the column scans as three short answers
 * instead of a wall of text.
 *
 * Controlled rather than stateful: the key reveal owns the content-capture
 * choice because the prompt and the snippets read it too, so flipping the
 * switch here rewrites them in place. The switch starts off; content capture
 * is something a customer turns on, never something they find already on.
 */
export function CaptureConsentPanel({
  captureContent,
  onCaptureContentChange,
  className,
}: {
  captureContent: boolean;
  onCaptureContentChange: (next: boolean) => void;
  className?: string;
}) {
  const headingId = useId();
  const toggleLabelId = useId();
  const toggleNoteId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "flex flex-col rounded-xl border border-forest-300/70 bg-base-deep/40 p-4",
        className,
      )}
    >
      <h3 id={headingId} className="eyebrow">
        What Ratel will read
      </h3>

      <ul className="mt-3 flex flex-col gap-3">
        {READ_SOURCES.map((source) => (
          <ReadSourceRow key={source.id} source={source} />
        ))}
      </ul>

      <p className="mt-3 text-pretty text-xs leading-relaxed text-warm-muted">{KEEP_BACK_NOTE}</p>

      <div className="mt-4 rounded-lg border border-forest-300/70 bg-forest-600/40 p-3">
        <div className="flex items-center justify-between gap-3">
          <span id={toggleLabelId} className="text-sm font-medium text-cream">
            {CAPTURE_TOGGLE_LABEL}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={captureContent}
            aria-labelledby={toggleLabelId}
            aria-describedby={toggleNoteId}
            onClick={() => onCaptureContentChange(!captureContent)}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral",
              captureContent ? "bg-coral" : "bg-forest-300",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "inline-block size-4 rounded-full bg-cream shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none",
                captureContent ? "translate-x-[18px]" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
        <p id={toggleNoteId} className="mt-2 text-pretty text-xs leading-relaxed text-warm-muted">
          {CAPTURE_TOGGLE_NOTE}
        </p>
      </div>

      <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-cream-dim">
        <Clock className="mt-0.5 size-3.5 shrink-0 text-warm-muted" aria-hidden />
        {FIRST_READING_PROMISE}
      </p>
    </section>
  );
}

function ReadSourceRow({ source }: { source: ReadSource }) {
  const Icon = SOURCE_ICON[source.id];
  return (
    <li data-read-source={source.id} className="flex gap-3">
      <span
        aria-hidden
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-forest-300/70 bg-forest-600/50 text-cream-dim"
      >
        <Icon className="size-3.5" strokeWidth={1.5} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-cream">{source.name}</span>
          <span className="rounded-full border border-forest-300 px-1.5 py-px font-mono text-[10px] text-cream-dim">
            {source.status}
          </span>
        </div>
        <p className="mt-1 text-pretty text-xs leading-relaxed text-warm-muted">{source.sends}</p>
        {source.unlocks ? (
          <details className="group mt-1">
            <summary className="cursor-pointer list-none text-xs text-cream-dim transition-colors hover:text-cream [&::-webkit-details-marker]:hidden">
              <span className="underline decoration-forest-300 underline-offset-2 group-open:no-underline">
                What it unlocks
              </span>
            </summary>
            <p className="mt-1 text-pretty text-xs leading-relaxed text-warm-muted">
              {source.unlocks}
            </p>
          </details>
        ) : (
          <PrivacyScale />
        )}
      </div>
    </li>
  );
}

/** The relay's levels as a scale, least to most: each step sends more than the one before. */
function PrivacyScale() {
  const last = RELAY_PRIVACY_LEVELS.length - 1;
  return (
    <ol aria-label="Privacy levels" className="mt-2 grid grid-cols-4 gap-1">
      {RELAY_PRIVACY_LEVELS.map((level, index) => (
        <li key={level} className="flex flex-col gap-1">
          <span
            aria-hidden
            className="h-1 rounded-full bg-cream"
            style={{ opacity: 0.12 + (index / last) * 0.6 }}
          />
          <span className="font-mono text-[10px] leading-tight text-cream-dim">{level}</span>
        </li>
      ))}
    </ol>
  );
}
