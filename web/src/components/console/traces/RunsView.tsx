"use client";

import { Button, IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ratel/design-system/menu";
import { Page, PageBody } from "@ratel/design-system/page-header";
import { usePeek } from "@ratel/design-system/panel";
import { Callout } from "@ratel/design-system/states";
import type { SortDirection } from "@ratel/design-system/table-model";
import { Check, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { MiniVolume } from "@/components/console/traces-sessions/MiniVolume";
import { SummaryFigure, SummaryNumbers } from "@/components/console/traces-sessions/TabSummary";
import type { ApiKeyCta } from "@/lib/console/api-key-cta";
import type { RangePreset } from "@/lib/synthesis/dashboard";
import type { TraceFacets } from "@/lib/synthesis/traces/queries";
import {
  withCursor,
  withoutCursor,
  withoutFilters,
  withRangePreset,
  withViewParam,
} from "@/lib/synthesis/traces/v2/filters";
import { TURN_NOUN } from "@/lib/synthesis/traces/v2/run-noun";
import {
  compareHref,
  compareSelection,
  type RunRow,
  type RunStat,
  toggleCompare,
  withCompareSelection,
} from "@/lib/synthesis/traces/v2/runs";
import {
  type VolumeModel,
  withDefaultRange,
  withSelectedDays,
} from "@/lib/synthesis/traces/v2/volume";
import { useTraceNavigation } from "./navigation";
import { type LoadRunSummary, RunPanel } from "./RunPanel";
import { CompareBar, ListFooter, type RunSort, RunsTable } from "./RunsTable";
import { fetchRunSummary } from "./run-summary-client";
import { TraceFilterBar } from "./TraceFilterBar";
import { TracesEmpty, type TracesEmptyKind } from "./TracesEmpty";
import { isToday, type TimeWindow, TracesHeader } from "./TracesHeader";

/** A calibration running in this window, in plain words (DESIGN.md, Glossary: arm is "variant"). */
export interface RunningExperiment {
  name: string;
  description: string;
  href: string;
}

export interface RunsViewProps {
  projectId: string;
  /** More actions for the page header. */
  actions?: ReactNode;
  /** The request time, so relative times render the same on server and client. */
  now: string;
  timeWindow: TimeWindow;
  rows: readonly RunRow[];
  /** Null when the window's numbers could not be read: the list still works. */
  stats: readonly RunStat[] | null;
  /** Null with `stats`: both come from the one aggregate read. */
  volume: VolumeModel | null;
  /** The page's tools and asks could not be read: rows show their run names and no tools. */
  detailsUnavailable?: boolean;
  facets: Pick<
    TraceFacets,
    "model" | "tool" | "service" | "environment" | "experiment" | "arm" | "name"
  >;
  /** `rollup` (RC-506): the property bar on the trace rollup. */
  filterTab?: "runs" | "rollup";
  /** `cloud-project-entities`: the rollup bar offers the Agent and MCP server filters (RC-790). */
  entities?: boolean;
  sort: { id: RunSort; direction: SortDirection };
  /** The next page's cursor, or null on the last page. */
  nextCursor: string | null;
  /** Whether this is a later page (a cursor is set). */
  paged: boolean;
  /** Why the list is empty, or null when it has runs. */
  empty: TracesEmptyKind | null;
  /** The API-key CTA the "no-telemetry" state shows (`loadApiKeyCta`); null otherwise. */
  apiKey?: ApiKeyCta | null;
  latestRunAt: string | null;
  /** A wider preset to offer when nothing is in the window. */
  widerPreset: { id: RangePreset; label: string } | null;
  experiment: RunningExperiment | null;
  /** Loads a run for the Panel; the summary route unless a test stubs it. */
  loadSummary?: LoadRunSummary;
}

const TRACE_COLUMNS_PARAM = "columns";

/**
 * Traces, Runs tab (v2): "What happened in my agent's runs?" One filter row
 * scopes everything under it: the key numbers, runs over time, and the list.
 * A row opens the run in a Panel; two picked runs open the compare page.
 */
export function RunsView(props: RunsViewProps) {
  const { projectId, now, timeWindow, rows, stats, volume, facets, sort, empty } = props;
  const { pathname, search, pending, go, refresh, replaceView } = useTraceNavigation();
  const peek = usePeek();
  const noun = TURN_NOUN;
  const tracesPath = `/project/${encodeURIComponent(projectId)}/traces`;
  const picked = compareSelection(search);
  const params = new URLSearchParams(search);
  const hasExperiments = rows.some((row) => row.experiment || row.variant);
  const showExperiment = hasExperiments && params.get(TRACE_COLUMNS_PARAM) === "experiment";
  const listSearch = withoutCursor(search);
  // The full trace carries the list's query, page included, so its crumb
  // returns to this exact view.
  const detailSearch = searchWithout(search, "peek");
  const traceHref = (id: string) => `${tracesPath}/${encodeURIComponent(id)}${detailSearch}`;
  const showFilterBar = empty === null || empty === "filtered" || empty === "outside-window";

  return (
    <Page>
      <TracesHeader
        projectId={projectId}
        search={search}
        timeWindow={timeWindow}
        onSearchChange={go}
        actions={props.actions}
      />
      <PageBody wide className="gap-6">
        {props.experiment ? (
          <Callout
            title={`Experiment ${props.experiment.name} is running`}
            action={
              <Link
                href={props.experiment.href}
                className="text-ui font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-subtle"
              >
                View results
              </Link>
            }
          >
            {props.experiment.description}
          </Callout>
        ) : null}

        {showFilterBar ? (
          <TraceFilterBar
            tab={props.filterTab ?? "runs"}
            entities={props.entities}
            search={search}
            pending={pending}
            facets={facets}
            onSearchChange={go}
            end={
              hasExperiments ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <IconButton
                        label="View options"
                        size="icon-sm"
                        icon={<SlidersHorizontal />}
                      />
                    }
                  />
                  <MenuContent align="end">
                    <MenuItem
                      icon={showExperiment ? <Check /> : <span aria-hidden className="size-4" />}
                      onClick={() =>
                        replaceView(
                          withViewParam(
                            search,
                            TRACE_COLUMNS_PARAM,
                            showExperiment ? null : "experiment",
                          ),
                        )
                      }
                    >
                      Show experiment column
                    </MenuItem>
                  </MenuContent>
                </Menu>
              ) : null
            }
          />
        ) : null}

        {empty ? (
          <div className="rounded-lg border border-line">
            <TracesEmpty
              kind={empty}
              unit="runs"
              apiKey={props.apiKey}
              latestAt={props.latestRunAt}
              onClearFilters={() =>
                go((current) => {
                  const cleared = withoutFilters("runs", current);
                  return props.entities
                    ? withoutFilters("rollup", cleared, { entities: true })
                    : cleared;
                })
              }
              onWiden={
                props.widerPreset
                  ? {
                      label: `Show ${props.widerPreset.label.toLowerCase()}`,
                      run: () => go((current) => withRangePreset(current, props.widerPreset!.id)),
                    }
                  : undefined
              }
            />
          </div>
        ) : (
          <div
            className={cn(
              "flex flex-col gap-8 transition-opacity duration-160",
              pending && "opacity-60",
            )}
            aria-busy={pending || undefined}
          >
            {stats && volume ? (
              // RC-752: the same summary card as the Sessions tab (TabSummaryView): numbers beside a small volume chart.
              <section
                aria-label={`${noun.many} summary`}
                data-tab-summary="turns"
                className="flex flex-col gap-3 rounded-lg border border-line bg-raised px-4 py-3"
              >
                {timeWindow.preset === "custom" && !isToday(timeWindow) ? (
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => go((current) => withDefaultRange(current))}
                    >
                      Reset range
                    </Button>
                  </div>
                ) : null}
                <SummaryNumbers
                  figures={stats.map((stat) => (
                    <SummaryFigure
                      key={stat.id}
                      label={stat.label}
                      value={stat.value}
                      hint={stat.hint}
                      danger={stat.tone === "danger"}
                    />
                  ))}
                  chart={
                    <MiniVolume
                      model={volume}
                      unit={noun.lowerMany}
                      errorLabel="failed"
                      className="min-w-60 flex-1"
                      onSelectDays={(days) => go((current) => withSelectedDays(current, days))}
                    />
                  }
                />
              </section>
            ) : (
              // A failed read is a Callout in place; the rest of the page still works (DESIGN.md, Errors).
              <Callout
                tone="danger"
                title="These numbers did not load"
                action={
                  <Button variant="secondary" size="sm" onClick={refresh}>
                    Try again
                  </Button>
                }
              >
                Reading this window took too long. The list below still works.
              </Callout>
            )}
            <section aria-label={noun.many} className="flex flex-col gap-3">
              {props.detailsUnavailable ? (
                <p role="status" className="flex min-h-8 items-center gap-2 text-ui text-fg-muted">
                  Tools and asks did not load for these {noun.lowerMany}.
                  <Button variant="ghost" size="sm" onClick={refresh}>
                    Try again
                  </Button>
                </p>
              ) : null}
              <RunsTable
                rows={rows}
                now={now}
                pathname={pathname}
                search={search}
                sort={sort}
                showExperiment={showExperiment}
                openId={peek.id}
                onOpen={(row) => peek.open(row.id)}
                picked={picked}
                onTogglePick={(id) =>
                  replaceView(withCompareSelection(search, toggleCompare(picked, id)))
                }
              />
              <ListFooter
                count={rows.length}
                noun={noun.lower}
                nextHref={
                  props.nextCursor !== null
                    ? `${pathname}${withCursor(search, props.nextCursor)}`
                    : null
                }
                firstHref={props.paged ? `${pathname}${listSearch}` : null}
              />
            </section>
          </div>
        )}
        <CompareBar
          picked={picked}
          href={compareHref(tracesPath, search, picked)}
          onClear={() => replaceView(withCompareSelection(search, []))}
        />
      </PageBody>
      <RunPanel
        projectId={projectId}
        openId={peek.id}
        rows={rows}
        now={now}
        traceHref={traceHref}
        loadSummary={props.loadSummary ?? fetchRunSummary}
        onOpen={peek.open}
        onClose={peek.close}
      />
    </Page>
  );
}

function searchWithout(search: string, name: string): string {
  const params = new URLSearchParams(search);
  params.delete(name);
  const text = params.toString();
  return text ? `?${text}` : "";
}
