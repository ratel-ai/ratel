import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { EmptyState } from "@ratel/design-system/states";
import { CircleAlert } from "lucide-react";
import type { ComponentProps } from "react";
import { drawnChart } from "@/lib/views/dashboards/sql-chart";
import { WidgetBody } from "./WidgetBody";

/** A widget's body as a card draws it, under the card's title row: on a dashboard and on the Overview. */
export function WidgetCardBody(props: Omit<ComponentProps<typeof WidgetBody>, "fill">) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1",
        // A chart's readout may reach out of it. A table scrolls: one drawn in place of a chart too.
        ["line", "bar"].includes(drawnChart(props.widget.chart, props.result))
          ? ""
          : "overflow-auto",
      )}
    >
      <WidgetBody {...props} fill />
    </div>
  );
}

/** An item that is no widget: why, and the way out. */
export function BrokenWidgetBody({
  problem,
  disabled = false,
  onRemove,
}: {
  problem: string;
  disabled?: boolean;
  /** Absent where nobody may remove it. */
  onRemove?: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <EmptyState
        icon={CircleAlert}
        title="This widget is broken"
        description={problem}
        action={
          onRemove ? (
            <Button variant="secondary" size="sm" disabled={disabled} onClick={onRemove}>
              Remove
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
