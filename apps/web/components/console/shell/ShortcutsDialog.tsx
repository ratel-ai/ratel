"use client";

import { Dialog, DialogContent } from "@ratel/design-system/dialog";
import { Kbd } from "@ratel/design-system/kbd";
import type { NavItem } from "@/lib/console/navigation";

/** Every shortcut on one card (DESIGN.md, Keyboard first). The jumps come from the rail. */
export function ShortcutsDialog({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly NavItem[];
}) {
  const jumps = items.filter((item) => item.shortcut);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts">
        <div className="grid gap-x-8 gap-y-2 text-ui sm:grid-cols-2">
          <Row keys={["⌘", "K"]} label="Search pages and projects" />
          <Row keys={["["]} label="Collapse the sidebar" />
          <Row keys={["J"]} label="Next row" />
          <Row keys={["K"]} label="Previous row" />
          <Row keys={["↵"]} label="Open the row" />
          <Row keys={["Esc"]} label="Close the panel" />
          <Row keys={["?"]} label="This list" />
        </div>
        {jumps.length > 0 ? (
          <div className="grid gap-x-8 gap-y-2 border-t border-line pt-4 text-ui sm:grid-cols-2">
            {jumps.map((item) => (
              <Row
                key={item.id}
                keys={["G", (item.shortcut ?? "").toUpperCase()]}
                label={item.label}
              />
            ))}
          </div>
        ) : null}
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
