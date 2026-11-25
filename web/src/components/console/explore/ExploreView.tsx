"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ratel/design-system/menu";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState, Skeleton } from "@ratel/design-system/states";
import { ChevronDown, Compass, Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { previewKey } from "@/components/console/dashboards/use-widget-preview";
import { TraceFilterBar } from "@/components/console/traces/TraceFilterBar";
import { type TimeWindow, TimeWindowMenu } from "@/components/console/traces/TracesHeader";
import type { QueryResult } from "@/lib/synthesis/metrics/query";
import { type TraceFilterBarFacets, withRangePreset } from "@/lib/synthesis/traces/v2/filters";
import { withSelectedDays } from "@/lib/synthesis/traces/v2/volume";
import { barChange, barSearch, DASHBOARD_FILTER_FIELDS } from "@/lib/views/dashboards/filters";
import { type DashboardRange, EXACT_RANGE } from "@/lib/views/dashboards/links";
import type { DashboardFilters, ScorerOption, WidgetInput } from "@/lib/views/dashboards/types";
import { STARTING_POINTS } from "@/lib/views/explore/starts";
import { withoutPanels } from "@/lib/views/explore/state";
import { MAX_PANELS } from "@/lib/views/explore/types";
import { ExplorePanel } from "./ExplorePanel";
import { type DashboardOption, SaveToDashboard } from "./SaveToDashboard";
import { useExplorePanels } from "./use-explore-panels";

/** One to four panels under one time window and one filter bar. The address is the whole state. */
export function ExploreView({
  projectId,
  served,
  problem,
  filters,
  facets,
  scorers,
  dashboards,
  range,
  timeWindow,
}: {
  projectId: string;
  /** The panels of the address with their numbers: null for one that failed, absent for one not read. */
  served: readonly { widget: WidgetInput; result: QueryResult | null | undefined }[];
  /** Why the address cannot be shown, or null. */
  problem: string | null;
  filters: DashboardFilters;
  facets: TraceFilterBarFacets;
  scorers: readonly ScorerOption[];
  dashboards: readonly DashboardOption[];
  /** What the panels read. */
  range: DashboardRange;
  /** Its days, for the menu. */
  timeWindow: TimeWindow;
}) {
  const explore = useExplorePanels(
    served.map(({ widget }) => widget),
    problem,
    served,
  );
  const { panels, search, pending, go, setPanels, newPanel } = explore;
  const [saved, setSaved] = useState<WidgetInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [filtersRefused, setFiltersRefused] = useState<string | null>(null);
  const { preset, from, to } = range;
  const servedResults = useMemo(
    () =>
      new Map(
        served.flatMap(({ widget, result }) =>
          result === undefined
            ? []
            : [[previewKey(widget, { preset, from, to }, filters), result] as const],
        ),
      ),
    [served, preset, from, to, filters],
  );
  const full = panels.length >= MAX_PANELS;

  return (
    <Page>
      <PageHeader
        title="Explore"
        actions={
          <>
            <TimeWindowMenu
              timeWindow={timeWindow}
              onToday={() =>
                go((current) =>
                  withSelectedDays(current, { from: timeWindow.today, to: timeWindow.today }),
                )
              }
              onSelect={(next) => go((current) => withRangePreset(current, next))}
            />
            {explore.problem === null ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={full}
                      title={full ? `Explore shows ${MAX_PANELS} panels at most.` : undefined}
                    />
                  }
                >
                  <Plus className="size-3.5" aria-hidden />
                  Add panel
                  <ChevronDown className="size-3.5" aria-hidden />
                </MenuTrigger>
                <MenuContent align="end">
                  {STARTING_POINTS.map(({ label, panel }) => (
                    <MenuItem
                      key={label}
                      onClick={() => setPanels((current) => [...current, newPanel(panel)])}
                    >
                      {label}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            ) : null}
          </>
        }
      />
      <PageBody wide>
        <TraceFilterBar
          tab="rollup"
          entities
          searchable={false}
          only={DASHBOARD_FILTER_FIELDS}
          pending={pending}
          facets={facets}
          search={barSearch(search, {})}
          onSearchChange={(next) => {
            // Every panel can be saved with the filters, so each must take them.
            const change = barChange(next, {
              search,
              saved: {},
              queries: panels.map(({ widget }) => widget.query),
            });
            setFiltersRefused(change.refused);
            if (!change.refused) go(change.go);
          }}
        />
        {filtersRefused ? (
          <p role="alert" className="text-xs text-danger">
            Not changed. {filtersRefused}
          </p>
        ) : null}
        {range.preset === EXACT_RANGE ? (
          <p className="text-xs text-fg-subtle">
            From {instant(range.from)} to {instant(range.to)} UTC
          </p>
        ) : null}
        {explore.problem !== null ? (
          <EmptyState
            icon={Compass}
            title="This link cannot be shown"
            description={explore.problem}
            action={
              <Link
                href={`/project/${encodeURIComponent(projectId)}/explore${withoutPanels(search)}`}
                className={buttonVariants({ variant: "secondary" })}
              >
                Reset
              </Link>
            }
          />
        ) : panels.length === 0 ? (
          // The panels are in the fragment, which the server has not.
          <Skeleton className="h-96 w-full" />
        ) : (
          <div
            className={cn(
              "grid items-start gap-4 transition-opacity duration-160",
              panels.length > 1 && "xl:grid-cols-2",
              pending && "opacity-60",
            )}
          >
            {panels.map(({ id, widget }) => (
              <ExplorePanel
                key={id}
                id={id}
                projectId={projectId}
                widget={widget}
                refused={explore.refused?.panelId === id ? explore.refused : null}
                served={servedResults}
                scorers={scorers}
                facets={facets}
                range={range}
                filters={filters}
                canDuplicate={!full}
                canRemove={panels.length > 1}
                onChange={(change) =>
                  setPanels((current) =>
                    current.map((panel) =>
                      panel.id === id ? { id, widget: change(panel.widget) } : panel,
                    ),
                  )
                }
                onDuplicate={() =>
                  setPanels((current) => {
                    const index = current.findIndex((panel) => panel.id === id);
                    return current.toSpliced(index + 1, 0, newPanel(current[index].widget));
                  })
                }
                onRemove={() => setPanels((current) => current.filter((panel) => panel.id !== id))}
                onSave={() => {
                  setSaved(widget);
                  setSaving(true);
                }}
              />
            ))}
          </div>
        )}
      </PageBody>
      {saved ? (
        <SaveToDashboard
          open={saving}
          onOpenChange={setSaving}
          projectId={projectId}
          widget={saved}
          filters={filters}
          dashboards={dashboards}
        />
      ) : null}
    </Page>
  );
}

/** "2026-11-24 12:00": seconds only where there are some. */
function instant(iso: string): string {
  return iso.slice(0, 19).replace("T", " ").replace(/:00$/, "");
}
