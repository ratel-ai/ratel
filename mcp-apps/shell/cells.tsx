"use client";

import { Badge } from "@ratel/design-system/badge";
import { IntentPin, NounIcon, TaskPin, ToolPin } from "@ratel/design-system/entity";
import { Lock } from "lucide-react";
/**
 * A configured value as the console shows it: text through format.ts, and the
 * formats that are marks (badge, entity pin, inline bar) as DS components.
 */
import type { ReactNode } from "react";
import { formatTimestamp, shortId } from "@/lib/synthesis/traces/v2/format";
import { type FieldConfig, getPath } from "./config";
import { type FormatContext, formatValue, MISSING, UNPRICED } from "./format";

/** Text a person wrote that this credential may not read (lib/mcp/operations/content-access.ts). */
export function Redacted() {
  return (
    <span
      className="inline-flex items-center gap-1 text-fg-subtle"
      title="Captured text is shown to signed-in members, or to API keys once content reading is on in project Settings."
    >
      <Lock aria-hidden className="size-3" strokeWidth={1.5} />
      Redacted
    </span>
  );
}

/** A field's value: its key, else its orKey when the key has none. */
export function fieldValue(field: FieldConfig, source: unknown): unknown {
  const own = getPath(source, field.key);
  return (own === null || own === undefined || own === "") && field.orKey
    ? getPath(source, field.orKey)
    : own;
}

export interface CellOptions {
  context?: FormatContext;
  /** The result said contentWithheld: a missing content field is redacted, not empty. */
  withheld?: boolean;
  /** For bar cells: the column's largest value. */
  max?: number;
  now?: Date;
}

export function Cell({
  field,
  source,
  options = {},
}: {
  field: FieldConfig;
  source: unknown;
  options?: CellOptions;
}): ReactNode {
  const value = fieldValue(field, source);
  const { context = "table", withheld = false, max, now } = options;
  if ((value === null || value === undefined) && field.content && withheld) return <Redacted />;

  switch (field.format) {
    case "currency":
      if (value === null) return <span className="text-fg-subtle">{UNPRICED}</span>;
      return value === undefined ? (
        <span className="text-fg-faint">{MISSING}</span>
      ) : (
        formatValue(value, "currency", context)
      );
    case "badge": {
      if (value === null || value === undefined)
        return <span className="text-fg-faint">{MISSING}</span>;
      const key = String(value);
      return <Badge tone={field.tones?.[key] ?? "neutral"}>{field.labels?.[key] ?? key}</Badge>;
    }
    case "entity": {
      if (value === null || value === undefined)
        return <span className="text-fg-faint">{MISSING}</span>;
      const name = String(value);
      if (field.noun === "tool" || field.noun === "skill")
        return <ToolPin name={name} kind={field.noun} />;
      if (field.noun === "intent") return <IntentPin name={name} />;
      if (field.noun === "task") return <TaskPin name={name} slot={null} />;
      return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {field.noun ? <NounIcon noun={field.noun} /> : null}
          <span className="truncate">{name}</span>
        </span>
      );
    }
    case "bar": {
      const number = Number(value);
      const share =
        max && max > 0 && Number.isFinite(number) ? Math.max(0, Math.min(1, number / max)) : 0;
      return (
        <span className="flex items-center justify-end gap-2">
          <span aria-hidden className="h-1.5 w-16 overflow-hidden rounded-full bg-hover">
            <span
              className="block h-full rounded-full bg-chart-1"
              style={{ width: `${share * 100}%` }}
            />
          </span>
          <span className="min-w-12 text-right tabular-nums">
            {formatValue(value, field.unit === "percent" ? "percent" : "bar", context)}
          </span>
        </span>
      );
    }
    case "date": {
      if (value === null || value === undefined || value === "")
        return <span className="text-fg-faint">{MISSING}</span>;
      const text = formatValue(value, "date", context, now);
      return context === "table" && !/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? (
        <time dateTime={String(value)} title={formatTimestamp(String(value))}>
          {text}
        </time>
      ) : (
        text
      );
    }
    case "id":
      return value === null || value === undefined ? (
        <span className="text-fg-faint">{MISSING}</span>
      ) : (
        <span className="font-mono text-xs text-fg-muted" title={String(value)}>
          {shortId(String(value))}
        </span>
      );
    default: {
      const text = formatValue(value, field.format ?? "text", context, now);
      return text === MISSING ? <span className="text-fg-faint">{MISSING}</span> : text;
    }
  }
}

/** Numbers align right (DESIGN.md, Numbers). */
export function isNumeric(field: FieldConfig): boolean {
  return (
    field.format === "number" ||
    field.format === "currency" ||
    field.format === "duration" ||
    field.format === "percent" ||
    field.format === "bar" ||
    field.format === "meter" ||
    field.format === "share" ||
    field.format === "whole" ||
    field.format === "per100" ||
    field.format === "taskCost" ||
    field.format === "points"
  );
}
