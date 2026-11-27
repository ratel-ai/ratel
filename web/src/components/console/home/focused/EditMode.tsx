"use client";

import { Button, IconButton } from "@ratel/design-system/button";
import { Dialog, DialogContent } from "@ratel/design-system/dialog";
import { Check, History, Pencil, Plus, Undo2 } from "lucide-react";
import { type ReactNode, useCallback, useRef } from "react";
import { EditModeBar, focusSoon, InertHeader } from "@/components/console/grid/EditBar";
import { DashboardWidgetPicker } from "@/components/console/home/focused/DashboardWidgetPicker";
import { HISTORY_ID } from "@/components/console/home/focused/edit-mode";
import { useOverviewLayout } from "@/components/console/home/focused/OverviewLayout";
import { offeredTo, WIDGETS } from "@/components/console/home/focused/widgets";
import {
  defaultLayout,
  type OverviewItemId,
  sameLayout,
} from "@/lib/views/overview-layout/domain/layout";

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
  return <InertHeader editing={editing}>{children}</InertHeader>;
}

/** Undo, History, Reset, Add widget and Done, over the header. It takes no room, so nothing moves when it comes, and it stays in reach when the page scrolls. */
export function EditBar() {
  const { editing, setEditing, layout, change, undoable, undo, saving, setAdding, setBrowsing } =
    useOverviewLayout();
  const leave = useCallback(() => {
    setEditing(false);
    focusSoon(EDIT_ID);
  }, [setEditing]);
  return (
    <EditModeBar
      editing={editing}
      label="Edit Overview"
      note="Only you see this layout."
      doneId={DONE_ID}
      onLeave={leave}
    >
      <IconButton
        label={undoable ? `Undo: ${undoable}` : "Undo"}
        icon={<Undo2 aria-hidden />}
        // A change that is on its way can be taken back too.
        disabled={undoable === null && !saving}
        focusableWhenDisabled
        onClick={() => undo()}
      />
      <IconButton
        id={HISTORY_ID}
        label="History"
        icon={<History aria-hidden />}
        aria-haspopup="dialog"
        onClick={() => setBrowsing(true)}
      />
      <Button
        variant="ghost"
        size="sm"
        disabled={sameLayout(layout, defaultLayout(offeredTo(layout)))}
        focusableWhenDisabled
        onClick={() => change({ kind: "reset" }, "The default layout is back")}
      >
        Reset
      </Button>
      <Button
        id={ADD_ID}
        aria-label="Add widget"
        aria-haspopup="dialog"
        size="sm"
        onClick={() => setAdding(true)}
      >
        <Plus aria-hidden />
        <span className="max-sm:hidden">Add widget</span>
      </Button>
    </EditModeBar>
  );
}

/** Every widget the Overview offers, and those of the dashboards: the ones on the page, and the ones to add. */
export function AddWidgetDialog() {
  const { adding, setAdding, setAdded, layout, change, said, readDashboardWidgets } =
    useOverviewLayout();
  const added = useRef<OverviewItemId[]>([]);
  const removed = new Set(layout.filter((widget) => widget.removed).map(({ id }) => id));
  return (
    <Dialog
      open={adding}
      onOpenChange={setAdding}
      onOpenChangeComplete={(open) => {
        if (open) return;
        document.getElementById(ADD_ID)?.focus({ preventScroll: true });
        setAdded(added.current);
        added.current = [];
      }}
    >
      <DialogContent
        title="Add widget"
        description="Added widgets go back to their last place. A dashboard widget goes to the bottom."
      >
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
                  onClick={() => {
                    added.current.push(id);
                    change({ kind: "add", widget: id }, `${title} added`);
                  }}
                >
                  {available ? <Plus aria-hidden /> : <Check aria-hidden />}
                  {available ? "Add" : "Added"}
                </Button>
              </li>
            );
          })}
        </ul>
        {readDashboardWidgets ? (
          <DashboardWidgetPicker
            read={readDashboardWidgets}
            onAdd={(id, source) => {
              added.current.push(id);
              change({ kind: "add", widget: id, source }, `${source.title} added`);
            }}
          />
        ) : null}
        <span className="sr-only" aria-live="polite">
          {said}
        </span>
      </DialogContent>
    </Dialog>
  );
}
