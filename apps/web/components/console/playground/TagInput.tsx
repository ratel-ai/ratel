"use client";

import { X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

/**
 * Tags as chips, not as a comma-separated string in a text field.
 *
 * Tags are indexed for ranking, so "is this one tag or two?" is a question with
 * a scoring consequence, and a plain text field leaves the reader guessing where
 * the boundaries fell. Committing on comma or Enter makes each tag a visible
 * object before it affects a search.
 */
export function TagInput({
  tags,
  onChange,
  label,
  id,
}: {
  tags: readonly string[];
  onChange: (tags: string[]) => void;
  label: string;
  id?: string;
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
    // Backspace on an empty field removes the last chip: the standard gesture,
    // and the only way to fix a typo'd tag without reaching for the mouse.
    if (event.key === "Backspace" && draft === "" && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-line-strong bg-app px-1.5 py-1 transition-[border-color] duration-120 focus-within:border-fg-subtle">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-raised pr-0.5 pl-1.5 font-mono text-xs text-fg-muted"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(tags.filter((candidate) => candidate !== tag))}
            className="inline-flex size-5 items-center justify-center rounded text-fg-subtle outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X aria-hidden strokeWidth={1.5} className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        aria-label={label}
        placeholder={tags.length === 0 ? "Add a tag…" : ""}
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
        className="h-6 min-w-24 flex-1 bg-transparent px-1 font-mono text-xs text-fg outline-none placeholder:text-fg-faint focus-visible:outline-none max-md:text-base"
      />
    </div>
  );
}
