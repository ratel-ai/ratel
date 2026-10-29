"use client";

import { Dialog, DialogContent } from "@ratel/design-system/dialog";
import { Kbd } from "@ratel/design-system/kbd";

/** Every shortcut on one card (DESIGN.md, Keyboard first). */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts">
        <div className="grid gap-x-8 gap-y-2 text-ui sm:grid-cols-2">
          <Row keys={["⌘", "K"]} label="Search pages and projects" />
          <Row keys={["["]} label="Collapse the sidebar" />
          <Row keys={["Esc"]} label="Close the dialog" />
          <Row keys={["?"]} label="This list" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ keys, label }: { keys: readonly string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-fg-muted">{label}</span>
      <span className="flex items-center gap-1">
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
    </div>
  );
}
