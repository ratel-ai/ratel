"use client";

import { Button } from "@ratel/design-system/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ratel/design-system/menu";
import { PageHeader } from "@ratel/design-system/page-header";
import { TabNav } from "@ratel/design-system/tabs";
import { CalendarRange, Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { RANGE_PRESETS, type RangePreset } from "@/lib/synthesis/dashboard";
import { tabSearch, withRangePreset } from "@/lib/synthesis/traces/v2/filters";
import { formatDayRange } from "@/lib/synthesis/traces/v2/format";
import { withSelectedDays } from "@/lib/synthesis/traces/v2/volume";
import type { SearchUpdate } from "./navigation";

export interface TimeWindow {
  preset: RangePreset | "custom";
  from: string;
  to: string;
  /** The request's UTC day, so "Today" reads the same on the server and the client. */
  today: string;
}

/**
 * The Traces frame shared by Runs, Spans and Logs: one title, the time window
 * on the right, and the tabs below. Tabs carry the window and the filters, so
 * moving between them keeps the question the reader is asking.
 */
export function TracesHeader({
  projectId,
  search,
  timeWindow,
  onSearchChange,
  actions,
}: {
  projectId: string;
  /** The current query string, with its `?`. */
  search: string;
  timeWindow: TimeWindow;
  /** Applies a new query string (the page owns navigation and its pending state). */
  onSearchChange: (next: SearchUpdate) => void;
  actions?: ReactNode;
}) {
  const root = `/project/${encodeURIComponent(projectId)}/traces`;
  const carried = tabSearch(search);
  return (
    <PageHeader
      title="Traces"
      actions={
        <>
          {actions}
          <TimeWindowMenu
            timeWindow={timeWindow}
            onToday={() =>
              onSearchChange((current) =>
                withSelectedDays(current, { from: timeWindow.today, to: timeWindow.today }),
              )
            }
            onSelect={(preset) => onSearchChange((current) => withRangePreset(current, preset))}
          />
        </>
      }
      tabs={
        <TabNav
          label="Traces sections"
          tabs={[
            { href: `${root}${carried}`, label: "Runs", exact: true },
            { href: `${root}/spans${carried}`, label: "Spans" },
            { href: `${root}/logs${carried}`, label: "Logs" },
          ]}
        />
      }
    />
  );
}

/** "Today" is the current UTC day, and says so: every window is whole UTC days. */
export const TODAY_LABEL = "Today (UTC)";

/** Today is a one-day window on the same day-based URL as a zoom (`range=custom`). */
export function isToday(timeWindow: TimeWindow): boolean {
  return (
    timeWindow.preset === "custom" &&
    timeWindow.from === timeWindow.today &&
    timeWindow.to === timeWindow.today
  );
}

export function timeWindowLabel(timeWindow: TimeWindow): string {
  if (isToday(timeWindow)) return TODAY_LABEL;
  if (timeWindow.preset === "custom")
    return formatDayRange(timeWindow.from, timeWindow.to, timeWindow.today);
  return RANGE_PRESETS.find((preset) => preset.id === timeWindow.preset)?.label ?? "Last 7 days";
}

/** Presets as rows (data-viz: nobody fights a calendar for "last 30 days"); a zoomed window shows its days. */
export function TimeWindowMenu({
  timeWindow,
  onToday,
  onSelect,
}: {
  timeWindow: TimeWindow;
  onToday: () => void;
  onSelect: (preset: RangePreset) => void;
}) {
  const label = timeWindowLabel(timeWindow);
  const today = isToday(timeWindow);
  const zoomed = timeWindow.preset === "custom" && !today;
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="secondary" size="sm" aria-label={`Time window: ${label}`} />}
      >
        <CalendarRange className="size-3.5 text-fg-subtle" aria-hidden />
        <span className="tabular-nums">{label}</span>
        <ChevronDown className="size-3.5 text-fg-subtle" aria-hidden />
      </MenuTrigger>
      <MenuContent align="end" className="min-w-52">
        {zoomed ? (
          <>
            <MenuItem icon={<Check />} disabled>
              {label}
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem icon={today ? <Check /> : <Spacer />} onClick={onToday}>
          {TODAY_LABEL}
        </MenuItem>
        {RANGE_PRESETS.map((preset) => (
          <MenuItem
            key={preset.id}
            icon={preset.id === timeWindow.preset ? <Check /> : <Spacer />}
            onClick={() => onSelect(preset.id)}
          >
            {preset.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function Spacer() {
  return <span aria-hidden className="size-4" />;
}
