"use client";

import { Button } from "@ratel/design-system/button";
import { Switch } from "@ratel/design-system/checkbox";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { LayoutDashboard } from "lucide-react";
import { useOverviewLayout } from "@/components/console/home/focused/OverviewLayout";
import { WIDGET_TITLES } from "@/components/console/home/focused/widgets";
import {
  DEFAULT_LAYOUT,
  OVERVIEW_WIDGETS,
  sameLayout,
} from "@/lib/views/overview-layout/domain/layout";

const PEEK = "customize";
export const CUSTOMIZE_ID = "overview-customize";

/** Which widgets the Overview shows, and the way back to the default. Nothing where nobody may change it. */
export function CustomizeButton({ id = CUSTOMIZE_ID }: { id?: string }) {
  const { editable } = useOverviewLayout();
  const peek = usePeek();
  if (!editable) return null;
  return (
    <Button
      id={id}
      variant="secondary"
      size="sm"
      aria-haspopup="dialog"
      onClick={() => peek.open(PEEK)}
    >
      <LayoutDashboard aria-hidden />
      Customize
    </Button>
  );
}

export function CustomizePanel() {
  const { editable, layout, change } = useOverviewLayout();
  const peek = usePeek();
  if (!editable) return null;
  const hidden = new Map(layout.map((widget) => [widget.id, widget.removed]));
  return (
    <Panel
      open={peek.id === PEEK}
      onOpenChange={(open) => {
        if (!open) peek.close();
      }}
      title="Customize Overview"
      subtitle="Only you see this layout"
    >
      <div className="flex flex-col gap-4">
        <ul className="divide-y divide-line rounded-lg border border-line">
          {OVERVIEW_WIDGETS.map((widget) => {
            const title = WIDGET_TITLES[widget];
            return (
              <li key={widget} className="flex min-h-11 items-center px-4 py-2">
                <Switch
                  className="w-full flex-row-reverse justify-between"
                  label={title}
                  checked={!hidden.get(widget)}
                  onCheckedChange={(shown) =>
                    change(
                      { kind: shown ? "add" : "remove", widget },
                      `${title} ${shown ? "shown" : "hidden"}`,
                    )
                  }
                />
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-ui text-fg-muted max-lg:hidden">
            Drag a widget by its header and resize it by its corner, or use its menu.
          </p>
          <Button
            variant="secondary"
            size="sm"
            disabled={sameLayout(layout, DEFAULT_LAYOUT)}
            onClick={() => change({ kind: "reset" }, "The default layout is back")}
          >
            Reset to default
          </Button>
        </div>
      </div>
    </Panel>
  );
}
