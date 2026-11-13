"use client";

import { Button } from "@ratel/design-system/button";
import { Textarea } from "@ratel/design-system/input";
import { toast } from "@ratel/design-system/toast";
import { Pencil } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { SearchableState } from "@/lib/console/catalog/items";
import { SEARCHABLE_ORIGIN_NOTE } from "@/lib/console/catalog/searchable";
import { CATALOG_DESCRIPTIONS } from "@/lib/ingest/catalogs/vocabulary";

/**
 * The searchable description, shown and edited in one place. The tree's
 * detail, the tools Panel and the skills Panel all render this component, so
 * there is exactly one way to change the field (DESIGN.md, one place to edit
 * each field). Saving is immediate and reversible: the caller's `onSave`
 * writes, and its toast carries the Undo. No confirmation step.
 *
 * The draft is reported up as it changes and read back on mount, so a caller
 * that keeps drafts per item (the Catalog store does) never loses one when the
 * reader looks at another item and comes back.
 */
export function SearchableDescription({
  searchable,
  onSave,
  onReset,
  notice,
  initialDraft = null,
  onDraftChange,
}: {
  searchable: SearchableState;
  /** Writes the draft. Resolves to an error for under the field, or null once saved. */
  onSave: (draft: string) => Promise<string | null>;
  /** Hands the text back to the runtime. Only offered while a Cloud copy is set over the runtime's text. */
  onReset?: () => Promise<string | null>;
  /** A quiet line under the text, such as whether the runtime has picked a save up yet. */
  notice?: ReactNode;
  /** An unsaved draft to reopen with; null shows the saved text. */
  initialDraft?: string | null;
  /** The draft as it changes; null once it is saved or dropped. */
  onDraftChange?: (draft: string | null) => void;
}) {
  const [draft, setDraftState] = useState<string | null>(initialDraft);
  const [pending, setPending] = useState<"save" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  // Focus moves only on the reader's own action: into the field on Edit, back to
  // Edit when the field closes. A draft reopened on mount leaves focus where it is.
  const focusField = useRef(false);
  const returnFocus = useRef(false);
  // Whether this editor is still on screen when a save settles: switching items
  // unmounts it, and a failure then has nowhere to show but a toast.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const headingId = useId();
  const noteId = useId();
  const editing = draft !== null;
  const runtimeOwned = searchable.target.type === "runtime";
  const originNote = SEARCHABLE_ORIGIN_NOTE[searchable.origin];

  useEffect(() => {
    if (!editing) {
      if (returnFocus.current) editButton.current?.focus();
      returnFocus.current = false;
      return;
    }
    if (!focusField.current) return;
    focusField.current = false;
    const element = field.current;
    element?.focus();
    element?.setSelectionRange(element.value.length, element.value.length);
  }, [editing]);

  function setDraft(next: string | null) {
    setDraftState(next);
    onDraftChange?.(next);
  }

  function start() {
    focusField.current = true;
    setError(null);
    setDraft(searchable.text);
  }

  function cancel() {
    returnFocus.current = true;
    setError(null);
    setDraft(null);
  }

  async function run(kind: "save" | "reset", action: () => Promise<string | null>) {
    if (pending) return;
    setPending(kind);
    setError(null);
    let failure: string | null;
    try {
      failure = await action();
    } finally {
      if (mounted.current) setPending(null);
    }
    if (failure) {
      if (!mounted.current) {
        toast({ title: failure, tone: "danger" });
        return;
      }
      // The field stays focusable while saving (read only, not disabled), so the error can take focus.
      setError(failure);
      field.current?.focus();
      return;
    }
    if (!mounted.current) return;
    returnFocus.current = true;
    setDraft(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && draft !== null) {
      event.preventDefault();
      void run("save", () => onSave(draft));
    } else if (event.key === "Escape") {
      // The first Escape leaves the field; only the next one closes a Panel around it.
      event.preventDefault();
      event.stopPropagation();
      // Mid-save, closing would hide how the save ends.
      if (!pending) cancel();
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      data-field="searchable-description"
      className="flex flex-col gap-2"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="text-xs font-medium text-fg-muted">
            {CATALOG_DESCRIPTIONS.searchable.label}
          </h3>
          <p className="text-xs text-fg-subtle">{CATALOG_DESCRIPTIONS.searchable.hint}</p>
        </div>
        {searchable.editable && !editing ? (
          <Button
            ref={editButton}
            size="sm"
            variant="ghost"
            onClick={start}
            aria-label="Edit searchable description"
          >
            <Pencil aria-hidden strokeWidth={1.5} className="size-3.5" />
            Edit
          </Button>
        ) : null}
      </div>

      {draft !== null ? (
        <div className="flex flex-col gap-2">
          <Textarea
            ref={field}
            value={draft}
            rows={4}
            aria-labelledby={headingId}
            aria-describedby={noteId}
            aria-invalid={error ? true : undefined}
            aria-busy={pending !== null || undefined}
            readOnly={pending !== null}
            placeholder="Words and phrases a search is likely to use."
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setError(null);
            }}
            onKeyDown={onKeyDown}
          />
          {error ? (
            <p id={noteId} role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : (
            <p id={noteId} className="text-xs text-fg-subtle">
              {runtimeOwned
                ? "Clear the field to use your runtime's text again. ⌘Enter saves."
                : "Clear the field to match on the agent description. ⌘Enter saves."}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={pending === "save"}
              onClick={() => void run("save", () => onSave(draft))}
            >
              {pending === "save" ? "Saving…" : "Save description"}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending !== null} onClick={cancel}>
              Cancel
            </Button>
            {onReset ? (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                loading={pending === "reset"}
                disabled={pending === "save"}
                onClick={() => void run("reset", onReset)}
              >
                {pending === "reset" ? "Resetting…" : "Use runtime text"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-sm whitespace-pre-wrap text-fg">
          {searchable.text.trim() !== "" ? (
            searchable.text
          ) : (
            <span className="text-fg-subtle">Empty</span>
          )}
        </p>
      )}

      {!editing && originNote ? <p className="text-xs text-fg-subtle">{originNote}</p> : null}
      {!editing ? notice : null}
    </section>
  );
}
