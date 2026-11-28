import { Button } from "@ratel/design-system/button";
import { DataTable } from "@ratel/design-system/data-table";
import { EmptyState } from "@ratel/design-system/states";
import { CircleAlert, LayoutDashboard } from "lucide-react";
import type { CSSProperties } from "react";
import { WidgetBody } from "@/components/console/dashboards/WidgetBody";
import { GRID_GAP_PX, GRID_ROW_PX } from "@/lib/console/grid/layout";
import type { DashboardClusters } from "@/lib/views/dashboards/clusters";
import { inReadingOrder } from "@/lib/views/dashboards/layout";
import type { ToolSuccess } from "../../shell/state";
import { ClustersTable } from "./clusters-table";
import { GroupsTable, type ViewGroups } from "./groups-table";
import {
  type DashboardModel,
  type DashboardText,
  readDashboard,
  readText,
  type ViewWidget,
} from "./model";

/** A dashboard, or a query's result, as the console draws it; read-only. */
export function Dashboard({
  result,
  openInConsole,
}: {
  result: ToolSuccess;
  openInConsole: (href: string) => void;
}) {
  const model = readDashboard(result);
  const shown = model ?? readText(result.data);
  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="truncate text-base font-semibold text-fg">{shown.name}</h1>
        {shown.href ? (
          <Button variant="ghost" size="sm" onClick={() => openInConsole(shown.href as string)}>
            Open in Ratel
          </Button>
        ) : null}
      </header>
      {shown.widgets.length === 0 ? (
        <EmptyState
          icon={LayoutDashboard}
          title="No widgets yet"
          description="Ask the agent to add one, or add it in Ratel."
        />
      ) : model ? (
        <Grid model={model} />
      ) : (
        <Lines text={shown as DashboardText} />
      )}
    </div>
  );
}

/** The stored grid on a wide frame, one column in reading order on a narrow one. */
function Grid({ model }: { model: DashboardModel }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:auto-rows-[40px] md:grid-cols-12">
      {inReadingOrder(model.widgets).map((item) => (
        <section
          key={item.id}
          data-widget={item.id}
          aria-label={item.name}
          style={cellOf(item.layout)}
          className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4 max-md:h-(--cell-height) md:[grid-column:var(--cell-column)] md:[grid-row:var(--cell-row)]"
        >
          <h2 className="truncate text-sm font-medium text-fg" title={item.name}>
            {item.name}
          </h2>
          <div
            className={
              item.widget && ["line", "bar"].includes(item.widget.chart)
                ? "min-h-0 flex-1"
                : "min-h-0 flex-1 overflow-auto"
            }
          >
            <Body item={item} model={model} />
          </div>
        </section>
      ))}
    </div>
  );
}

function Body({ item, model }: { item: ViewWidget; model: DashboardModel }) {
  if (!item.widget)
    return (
      <EmptyState
        icon={CircleAlert}
        title="This widget needs attention"
        description={item.problem}
      />
    );
  // The console's own drawings of them are the Intents map's: this view links to it.
  if (item.result?.kind === "clusters")
    return <ClustersTable projectId={model.projectId} result={item.result as DashboardClusters} />;
  // A small chart per value does not fit a cell of a view: the values and their numbers do.
  if (item.result?.kind === "grouped") return <GroupsTable result={item.result as ViewGroups} />;
  return (
    <WidgetBody
      projectId={model.projectId}
      widget={item.widget}
      result={item.result}
      range={model.range}
      filters={model.filters}
      missingScorer={item.missingScorer}
      fill
    />
  );
}

/** A host that passed the text only: each widget's numbers in one line. */
function Lines({ text }: { text: DashboardText }) {
  return (
    <DataTable
      caption={text.name}
      density="compact"
      rows={text.widgets}
      rowKey={({ id }) => id}
      columns={[
        { id: "name", header: "Widget", cell: ({ name }) => name },
        { id: "summary", header: "Numbers", cell: ({ summary }) => summary },
      ]}
    />
  );
}

function cellOf({ x, y, w, h }: ViewWidget["layout"]): CSSProperties {
  return {
    "--cell-column": `${x + 1} / span ${w}`,
    "--cell-row": `${y + 1} / span ${h}`,
    "--cell-height": `${h * (GRID_ROW_PX + GRID_GAP_PX) - GRID_GAP_PX}px`,
  } as CSSProperties;
}
