"use client";

import { Button } from "@ratel/design-system/button";
import { type ReactNode, useEffect } from "react";
import { keyLeavesEditMode, TOASTS, takesEscape } from "@/lib/console/grid/edit-mode";

/**
 * The bar of edit mode, over the header. It takes no room, so nothing moves when it comes, and it
 * stays in reach when the page scrolls. Done and Escape leave.
 */
export function EditModeBar({
  editing,
  label,
  note,
  doneId,
  onLeave,
  children,
}: {
  editing: boolean;
  label: string;
  /** Who sees the changes. */
  note: string;
  doneId: string;
  onLeave: () => void;
  /** The page's own controls, before Done. */
  children: ReactNode;
}) {
  useEscape(editing, onLeave);
  return (
    <div className="sticky top-[calc(var(--support-bar,0px)+3rem)] z-sticky h-0 md:top-[var(--support-bar,0px)]">
      {editing ? (
        <section
          aria-label={label}
          data-edit-bar=""
          className="flex h-13 items-center justify-end gap-2 border-b border-line-strong bg-app px-6 max-sm:gap-1 max-sm:px-4 lg:px-8"
        >
          <p className="min-w-0 flex-1 truncate text-ui text-fg-muted max-sm:hidden">
            {label}. <span className="max-lg:hidden">{note}</span>
          </p>
          {children}
          <Button id={doneId} variant="primary" size="sm" onClick={onLeave}>
            Done
          </Button>
        </section>
      ) : null}
    </div>
  );
}

/** The page's header, out of reach while the edit bar is over it. */
export function InertHeader({ editing, children }: { editing: boolean; children: ReactNode }) {
  return (
    <div inert={editing} className="inert:opacity-40">
      {children}
    </div>
  );
}

/** After React has drawn the change that brings the element. */
export function focusSoon(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

/**
 * Escape in edit mode. It looks before anything else reacts (the capture phase of the window), so
 * a layer that the same key closes still counts as open: to leave then takes a second Escape.
 */
function useEscape(editing: boolean, leave: () => void) {
  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const moment = {
        key: event.key,
        continued: event.repeat || event.isComposing,
        layerOpen: openLayer(),
        arranging: document.querySelector(ARRANGING) !== null,
        fieldFocused: document.activeElement?.closest(`${FIELD}, ${TOASTS}`) != null,
      };
      if (keyLeavesEditMode(moment)) leave();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [editing, leave]);
}

const LAYERS = ["dialog", "alertdialog", "menu", "listbox"]
  .map((role) => `[role="${role}"]:not([data-closed])`)
  .join(", ");
const ARRANGING = ".react-draggable-dragging, .react-grid-item.resizing";
const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

function openLayer(): boolean {
  return [...document.querySelectorAll(LAYERS)].some(takesEscape);
}
