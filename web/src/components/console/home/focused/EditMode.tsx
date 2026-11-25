"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogContent } from "@ratel/design-system/dialog";
import { Check, Pencil, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useOverviewLayout } from "@/components/console/home/focused/OverviewLayout";
import { offeredTo, WIDGETS } from "@/components/console/home/focused/widgets";
import { defaultLayout, sameLayout } from "@/lib/views/overview-layout/domain/layout";

export const EDIT_ID = "overview-edit";
export const DONE_ID = "overview-done";
export const ADD_ID = "overview-add-widget";

/** Starts edit mode. Nothing where nobody may change the layout. */
export function EditButton({ id = EDIT_ID }: { id?: string }) {
  const { editable, setEditing } = useOverviewLayout();
  if (!editable) return null;
  return (
    <Button
      id={id}
      variant="secondary"
      size="sm"
      onClick={() => {
        setEditing(true);
        focusSoon(DONE_ID);
      }}
    >
      <Pencil aria-hidden />
      Edit
    </Button>
  );
}

/** The page's header, out of reach while the edit bar is over it. */
export function HeaderInEditMode({ children }: { children: ReactNode }) {
  const { editing } = useOverviewLayout();
  return (
    <div inert={editing} className="inert:opacity-40">
      {children}
    </div>
  );
}

/** Add widget, Reset and Done, over the header. It takes no room, so nothing moves when it comes, and it stays in reach when the page scrolls. */
export function EditBar() {
  const { editing, setEditing, layout, change, setAdding } = useOverviewLayout();
  return (
    <div className="sticky top-[calc(var(--support-bar,0px)+3rem)] z-sticky h-0 md:top-[var(--support-bar,0px)]">
      {editing ? (
        <section
          aria-label="Edit Overview"
          data-overview-edit-bar=""
          className="flex h-13 items-center justify-end gap-2 border-b border-line-strong bg-app px-6 lg:px-8"
        >
          <p className="min-w-0 flex-1 truncate text-ui text-fg-muted max-sm:hidden">
            Edit Overview. <span className="max-lg:hidden">Only you see this layout.</span>
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={sameLayout(layout, defaultLayout(offeredTo(layout)))}
            focusableWhenDisabled
            onClick={() => change({ kind: "reset" }, "The default layout is back")}
          >
            Reset
          </Button>
          <Button id={ADD_ID} aria-haspopup="dialog" size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add widget
          </Button>
          <Button
            id={DONE_ID}
            variant="primary"
            size="sm"
            onClick={() => {
              setEditing(false);
              focusSoon(EDIT_ID);
            }}
          >
            Done
          </Button>
        </section>
      ) : null}
    </div>
  );
}

/** Every widget the Overview offers: the ones on the page, and the ones to add. */
export function AddWidgetDialog() {
  const { adding, setAdding, layout, change, said } = useOverviewLayout();
  const removed = new Set(layout.filter((widget) => widget.removed).map(({ id }) => id));
  return (
    <Dialog
      open={adding}
      onOpenChange={setAdding}
      onOpenChangeComplete={(open) => {
        if (!open) document.getElementById(ADD_ID)?.focus();
      }}
    >
      <DialogContent title="Add widget" description="Added widgets go back to their last place.">
        <ul className="divide-y divide-line">
          {offeredTo(layout).map(({ id }) => {
            const { title, description, icon: Icon } = WIDGETS[id];
            const available = removed.has(id);
            return (
              <li key={id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <Icon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block text-ui font-medium text-fg">{title}</span>
                  <span className="block text-xs text-fg-subtle">{description}</span>
                </span>
                <Button
                  size="sm"
                  aria-label={available ? `Add ${title}` : `${title} is added`}
                  variant={available ? "secondary" : "ghost"}
                  disabled={!available}
                  focusableWhenDisabled
                  onClick={() => change({ kind: "add", widget: id }, `${title} added`)}
                >
                  {available ? <Plus aria-hidden /> : <Check aria-hidden />}
                  {available ? "Add" : "Added"}
                </Button>
              </li>
            );
          })}
        </ul>
        <span className="sr-only" aria-live="polite">
          {said}
        </span>
      </DialogContent>
    </Dialog>
  );
}

/** After React has drawn the change that brings the element. */
export function focusSoon(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}
