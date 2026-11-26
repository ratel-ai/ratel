"use client";

import { cn } from "@ratel/design-system/cn";
import { ChevronRight } from "lucide-react";
import { useId } from "react";
import {
  CAPTURE_TOGGLE_LABEL,
  CAPTURE_TOGGLE_NOTE,
  FIRST_READING_PROMISE,
  KEEP_BACK_NOTE,
  READ_SOURCES,
  RELAY_PRIVACY_LEVELS,
  type ReadSource,
} from "@/lib/console/onboarding/capture-consent";

/**
 * "What Ratel will read" on the key reveal, kept quiet: the content-capture
 * switch is the one line on show, and the full account of what each source
 * sends and unlocks sits one click down, for whoever wants to read it.
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
    <section aria-labelledby={headingId} className={cn("flex flex-col", className)}>
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <span id={toggleLabelId} className="text-sm text-fg">
            {CAPTURE_TOGGLE_LABEL}
          </span>
          <p
            id={toggleNoteId}
            className="mt-0.5 text-pretty text-xs leading-relaxed text-fg-subtle"
          >
            {CAPTURE_TOGGLE_NOTE}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={captureContent}
          aria-labelledby={toggleLabelId}
          aria-describedby={toggleNoteId}
          onClick={() => onCaptureContentChange(!captureContent)}
          className={cn(
            "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
            captureContent ? "bg-accent" : "bg-line-strong",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "inline-block size-4 rounded-full bg-fg transition-transform duration-200 ease-out motion-reduce:transition-none",
              captureContent ? "translate-x-[18px]" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      <details className="group mt-4">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="size-3.5 transition-transform duration-120 group-open:rotate-90"
            aria-hidden
          />
          <h3 id={headingId} className="font-normal">
            What Ratel will read
          </h3>
        </summary>
        <div className="mt-3 pl-[18px]">
          <ul className="flex flex-col gap-3">
            {READ_SOURCES.map((source) => (
              <ReadSourceRow key={source.id} source={source} />
            ))}
          </ul>
          <p className="mt-3 text-pretty text-xs leading-relaxed text-fg-subtle">
            {KEEP_BACK_NOTE} {FIRST_READING_PROMISE}
          </p>
        </div>
      </details>
    </section>
  );
}

function ReadSourceRow({ source }: { source: ReadSource }) {
  return (
    <li data-read-source={source.id} className="text-xs leading-relaxed">
      <p>
        <span className="text-fg">{source.name}</span>
        <span className="text-fg-faint"> · {source.status}</span>
      </p>
      <p className="mt-0.5 text-pretty text-fg-subtle">{source.sends}</p>
      {source.unlocks ? (
        <p className="mt-0.5 text-pretty text-fg-subtle">
          <span className="text-fg-muted">Unlocks: </span>
          {source.unlocks}
        </p>
      ) : (
        <ol aria-label="Privacy levels" className="mt-1 flex flex-wrap gap-x-1.5 text-fg-muted">
          {RELAY_PRIVACY_LEVELS.map((level, index) => (
            <li key={level} className="flex items-center gap-1.5">
              {index > 0 && (
                <span aria-hidden className="text-fg-faint">
                  →
                </span>
              )}
              <span>{level}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
