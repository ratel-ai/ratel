"use client";

import { Button } from "@ratel/design-system/button";
import { Input } from "@ratel/design-system/input";
import { X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

/** Tags as chips, not as a comma-separated string in a text field. */
export function TagInput({
  tags,
  onChange,
  label,
}: {
  tags: readonly string[];
  onChange: (tags: string[]) => void;
  label: string;
}) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const tag = raw.trim();
    if (tag === "" || tags.includes(tag)) {
      setDraft("");
      return;
    }
    onChange([...tags, tag]);
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "," || event.key === "Enter") {
      event.preventDefault();
      commit(draft);
      return;
    }
    if (event.key === "Backspace" && draft === "" && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-forest-300 bg-base-deep/40 px-2 py-1.5 focus-within:border-cream/45">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-md border border-forest-300 bg-forest/50 py-0.5 pr-1 pl-1.5 font-mono text-[10px] text-cream-dim"
        >
          {tag}
          <Button
            variant="ghost"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(tags.filter((candidate) => candidate !== tag))}
            className="size-auto rounded border-0 p-0 text-warm-muted transition-colors hover:bg-transparent hover:text-coral focus-visible:ring-1 focus-visible:ring-offset-0"
          >
            <X className="size-3" aria-hidden />
          </Button>
        </span>
      ))}
      <Input
        value={draft}
        aria-label={label}
        placeholder={tags.length === 0 ? "add a tag…" : ""}
        onChange={(event) => {
          // Paste of "a, b, c" should become three chips, not one long tag.
          if (event.target.value.includes(",")) {
            const parts = event.target.value.split(",");
            parts.slice(0, -1).forEach(commit);
            setDraft(parts.at(-1)?.trimStart() ?? "");
            return;
          }
          setDraft(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(draft)}
        className="h-auto w-auto min-w-24 flex-1 rounded-none border-0 bg-transparent px-0 py-0.5 font-mono text-[11px] text-cream placeholder:text-warm-muted/50 focus-visible:ring-0 max-md:text-[11px]"
      />
    </div>
  );
}
