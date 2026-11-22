"use client";

import { cn } from "@ratel/design-system/cn";
import { type UIEvent, useRef } from "react";
import { templateSegments } from "@/lib/views/sandboxes/playground-state";

/** Shared by the backdrop and the textarea, so the highlighted vars sit under the caret's text exactly. */
const TEXT =
  "font-mono text-xs leading-5 px-2.5 py-2 whitespace-pre-wrap break-words [scrollbar-gutter:stable]";

/**
 * A prompt template editor: a textarea over a backdrop that draws the same
 * text with `{{var}}` and `${var}` lit, so the vars the code renders stand out.
 */
export function PromptEditor({
  id,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const onScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    if (backdrop.current) backdrop.current.scrollTop = event.currentTarget.scrollTop;
  };
  return (
    <div
      className={cn(
        "relative h-48 overflow-hidden rounded-md border border-line-strong bg-app transition-[border-color] duration-120 focus-within:border-fg-subtle hover:border-line-active",
        invalid && "border-danger",
      )}
    >
      <div
        ref={backdrop}
        aria-hidden
        className={cn(TEXT, "absolute inset-0 overflow-hidden text-fg")}
      >
        {templateSegments(value).map((segment, index) =>
          segment.variable ? (
            <mark key={index} className="rounded-sm bg-info-subtle text-info">
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
        {/* A trailing newline needs a character to take its height. */}
        {"​"}
      </div>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={onScroll}
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(
          TEXT,
          "absolute inset-0 resize-none overflow-y-auto bg-transparent text-transparent caret-fg outline-none selection:bg-accent-subtle selection:text-fg",
        )}
      />
    </div>
  );
}
