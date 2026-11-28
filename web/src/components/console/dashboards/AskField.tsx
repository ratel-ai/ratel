"use client";

import { Button } from "@ratel/design-system/button";
import { Field, Textarea } from "@ratel/design-system/input";
import { Sparkles } from "lucide-react";
import { ASK_MAX_WORDS } from "@/lib/views/ask/limits";

/**
 * Ask in words: the person says what to show, or takes a suggested prompt. A click on a prompt
 * puts its sentence in the field. `onAsk` is absent where the field only collects the words (the
 * Create dashboard dialog asks from its own button). The reason of a stop or a refusal shows under
 * the field.
 */
export function AskField({
  label,
  placeholder,
  words,
  onWords,
  prompts,
  asking = false,
  onAsk,
  note,
  problem,
}: {
  label: string;
  placeholder: string;
  words: string;
  onWords: (words: string) => void;
  prompts: readonly string[];
  asking?: boolean;
  onAsk?: () => void;
  /** What the last draft gave, said under the field. */
  note?: string | null;
  /** Why the last ask gave nothing, said under the field. */
  problem?: string | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Field label={label}>
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            value={words}
            maxLength={ASK_MAX_WORDS}
            placeholder={placeholder}
            onChange={(event) => onWords(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (!onAsk || event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              if (words.trim() && !asking) onAsk();
            }}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-1.5">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="rounded-full border border-line px-2.5 py-1 text-xs text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
            onClick={() => onWords(prompt)}
          >
            {prompt}
          </button>
        ))}
        {onAsk ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="ml-auto"
            loading={asking}
            disabled={!words.trim()}
            onClick={onAsk}
          >
            <Sparkles aria-hidden />
            Draft
          </Button>
        ) : null}
      </div>
      {problem ? (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      ) : note ? (
        <p role="status" className="text-xs text-fg-subtle">
          {note}
        </p>
      ) : null}
    </div>
  );
}
