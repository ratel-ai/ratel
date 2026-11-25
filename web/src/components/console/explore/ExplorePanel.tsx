"use client";

import { Button, IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ratel/design-system/menu";
import { Skeleton } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { Braces, ChevronDown, Copy, Ellipsis, LayoutDashboard, Trash2 } from "lucide-react";
import {
  type ServedResults,
  useWidgetPreview,
} from "@/components/console/dashboards/use-widget-preview";
import { WidgetBody } from "@/components/console/dashboards/WidgetBody";
import { WidgetFields } from "@/components/console/dashboards/WidgetFields";
import { WidgetLinkItems } from "@/components/console/dashboards/WidgetLinkItems";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import type { DashboardRange } from "@/lib/views/dashboards/links";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import type { DashboardFilters, ScorerOption, WidgetInput } from "@/lib/views/dashboards/types";
import { isFilterable, widgetName } from "@/lib/views/dashboards/widget";
import { STARTING_POINTS } from "@/lib/views/explore/starts";
import type { RefusedChange } from "./use-explore-panels";

/** One query: its fields, and its result under them as they change. */
export function ExplorePanel({
  id,
  projectId,
  widget,
  refused,
  served,
  scorers,
  facets,
  range,
  filters,
  canDuplicate,
  canRemove,
  onChange,
  onDuplicate,
  onRemove,
  onSave,
}: {
  id: string;
  projectId: string;
  widget: WidgetInput;
  refused: RefusedChange | null;
  /** What the page came with, so that the first numbers need no request. */
  served: ServedResults;
  scorers: readonly ScorerOption[] | null;
  facets: TraceFilterBarFacets;
  range: DashboardRange;
  filters: DashboardFilters;
  canDuplicate: boolean;
  canRemove: boolean;
  onChange: (change: (current: WidgetInput) => WidgetInput) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onSave: () => void;
}) {
  const { preview, pending } = useWidgetPreview(projectId, widget, range, filters, served);
  const name = widgetName(widget);
  const complete = parseWidget(widget, { customMonitoring: scorers !== null }).ok;

  async function copyQuery() {
    try {
      await navigator.clipboard.writeText(`${JSON.stringify(widget.query, null, 2)}\n`);
      toast({ title: "Query JSON copied" });
    } catch {
      toast({ title: "The query could not be copied.", tone: "danger" });
    }
  }

  return (
    <section
      aria-labelledby={`${id}-name`}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-app p-4"
    >
      <div className="flex items-center gap-2">
        <h2 id={`${id}-name`} className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
          {name}
        </h2>
        {Object.keys(filters).length > 0 &&
        !isFilterable(widget.query) &&
        widget.query.kind !== "clusters" ? (
          <p className="shrink-0 text-xs text-fg-subtle">Not filtered</p>
        ) : null}
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="sm" />}>
            Start from
            <ChevronDown className="size-3.5" aria-hidden />
          </MenuTrigger>
          <MenuContent align="end">
            {STARTING_POINTS.map(({ label, panel }) => (
              <MenuItem key={label} onClick={() => onChange(() => panel)}>
                {label}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <Menu>
          <MenuTrigger
            render={<IconButton label={`${name} actions`} size="icon-sm" icon={<Ellipsis />} />}
          />
          <MenuContent align="end">
            <MenuItem icon={<LayoutDashboard />} disabled={!complete} onClick={onSave}>
              Save to dashboard
            </MenuItem>
            <MenuSeparator />
            <WidgetLinkItems
              projectId={projectId}
              widget={widget}
              filters={filters}
              range={range}
              exploreHref={null}
              alerts
              alertWithFilters
            />
            <MenuSeparator />
            <MenuItem icon={<Braces />} onClick={() => void copyQuery()}>
              Copy query JSON
            </MenuItem>
            <MenuItem icon={<Copy />} disabled={!canDuplicate} onClick={onDuplicate}>
              Duplicate
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} tone="danger" disabled={!canRemove} onClick={onRemove}>
              Remove
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <WidgetFields
        widget={widget}
        onChange={onChange}
        scorers={scorers}
        facets={facets}
        result={preview?.ok ? preview.result : null}
        refused={refused}
      />
      <div
        aria-busy={pending || undefined}
        className={cn(
          "min-h-64 min-w-0 border-t border-line pt-4 transition-opacity duration-160",
          pending && preview && "opacity-60",
        )}
      >
        {preview ? (
          preview.ok ? (
            <WidgetBody
              projectId={projectId}
              widget={preview.widget}
              result={preview.result}
              range={range}
              filters={filters}
            />
          ) : (
            <p role="status" className="text-sm text-danger">
              {preview.error}
            </p>
          )
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </div>
    </section>
  );
}
