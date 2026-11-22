"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { TriangleAlert } from "lucide-react";
/**
 * The console's own table cells, for the formats named after them (shell/config.ts
 * CELL_FORMATS): status (StatusDot, components/traces/v2/RunsTable.tsx),
 * relative and tools (components/traces/v2/cells.tsx), taskStatus
 * (components/tasks/TaskMarks.tsx), meter (the intents table's DotMeter) and
 * sentiment (components/intents/v2/SentimentBar.tsx). Only the list view uses
 * them: they bring the console's Tooltip, which the other views do not carry.
 */
import type { ReactNode } from "react";
import { SentimentBar } from "@/components/console/intents/SentimentBar";
import { TaskStatusBadge } from "@/components/console/tasks/TaskMarks";
import { RelativeTime, ToolBadges } from "@/components/console/traces/cells";
import type { TopicView } from "@/lib/views/intents/topics-view";
import type { TaskStatus } from "@/lib/views/tasks/status";
import { Cell, type CellOptions, fieldValue } from "./cells";
import { type CellFormat, type FieldConfig, getPath } from "./config";
import { formatValue, MISSING } from "./format";

const CONSOLE_FORMATS: ReadonlySet<CellFormat> = new Set([
  "status",
  "relative",
  "tools",
  "taskStatus",
  "meter",
  "sentiment",
]);

export function ConsoleCell({
  field,
  source,
  options = {},
}: {
  field: FieldConfig;
  source: unknown;
  options?: CellOptions;
}): ReactNode {
  if (!field.format || !CONSOLE_FORMATS.has(field.format))
    return <Cell field={field} source={source} options={options} />;
  const value = fieldValue(field, source);
  const { context = "table", now } = options;
  switch (field.format) {
    case "status": {
      if (value === null || value === undefined)
        return <span className="text-fg-faint">{MISSING}</span>;
      const key = String(value);
      const tone = field.tones?.[key] ?? "neutral";
      return (
        <StatusDot tone={tone === "accent" ? "neutral" : tone} label={field.labels?.[key] ?? key} />
      );
    }
    case "relative":
      if (typeof value !== "string" || value === "")
        return <span className="text-fg-faint">{MISSING}</span>;
      return <RelativeTime value={value} now={(now ?? new Date()).toISOString()} />;
    case "tools":
      return Array.isArray(value) ? (
        <ToolBadges tools={value.map(String)} />
      ) : (
        <span className="text-fg-faint">{MISSING}</span>
      );
    case "taskStatus":
      return typeof value === "string" ? (
        <TaskStatusBadge status={value as TaskStatus} />
      ) : (
        <span className="text-fg-faint">{MISSING}</span>
      );
    case "meter": {
      const share = Number(value);
      if (value === null || value === undefined || !Number.isFinite(share))
        return <span className="text-fg-faint">{MISSING}</span>;
      const warn = field.warnKey ? getPath(source, field.warnKey) === true : false;
      // The number beside the dots is the intents table's: a whole percent.
      const text = formatValue(share, "meter", context);
      return (
        <span className="inline-flex items-center justify-end gap-2 tabular-nums">
          <DotMeter
            value={Math.max(0, Math.min(1, share))}
            cells={10}
            tone={warn ? "warning" : "neutral"}
            label={`${field.label} ${text}`}
            className="max-sm:hidden"
          />
          <span className="min-w-9 text-right">{text}</span>
          {warn ? (
            <TriangleAlert aria-label="Warning" className="size-3.5 shrink-0 text-warning" />
          ) : null}
        </span>
      );
    }
    case "sentiment":
      return <SentimentBar sentiment={(value ?? null) as TopicView["sentiment"]} />;
    default:
      return <Cell field={field} source={source} options={options} />;
  }
}
