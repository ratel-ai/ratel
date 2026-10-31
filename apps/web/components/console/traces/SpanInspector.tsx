"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { CopyButton } from "@ratel/design-system/code";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  formatAttributeValue,
  formatSpanKind,
  formatSpanStatus,
} from "@/lib/synthesis/traces/format";
import {
  formatDuration,
  formatInteger,
  formatMoney,
  formatTimestamp,
} from "@/lib/synthesis/traces/v2/format";
import {
  STEP_KIND_LABEL,
  stepKind,
  stepTitle,
  stringAttribute,
} from "@/lib/synthesis/traces/v2/span-kind";
import type { TraceSpanView } from "@/lib/synthesis/traces/view";

/**
 * The selected step in plain words, beside the timeline: what it was, how long
 * it took, what it cost and how it ended. Raw names and every attribute live
 * in the Details tab.
 */
export function SpanInspector({
  span,
  offsetMs,
  runtimeEventsRoot,
  onShowDetails,
}: {
  span: TraceSpanView;
  offsetMs: number;
  runtimeEventsRoot: string | null;
  onShowDetails: () => void;
}) {
  const kind = stepKind(span);
  const failed = span.statusCode === 2;
  const tokens = (span.inputTokens ?? 0) + (span.outputTokens ?? 0);
  const errorType = failed ? stringAttribute(span.attributes, "error.type") : null;
  const facts: { label: string; value: ReactNode }[] = [
    { label: "Duration", value: formatDuration(span.durationMs) },
    { label: "Starts at", value: `+${formatDuration(offsetMs)}` },
    ...(span.model ? [{ label: "Model", value: span.model }] : []),
    ...(tokens > 0
      ? [
          {
            label: "Tokens",
            value: `${formatInteger(tokens)} (${formatInteger(span.inputTokens ?? 0)} in, ${formatInteger(span.outputTokens ?? 0)} out)`,
          },
        ]
      : []),
    ...(span.costUsd !== null && Number(span.costUsd) > 0
      ? [{ label: "Cost", value: formatMoney(span.costUsd) }]
      : []),
    ...(span.searchQuery ? [{ label: "Query", value: span.searchQuery }] : []),
    ...(span.searchTarget ? [{ label: "Searched", value: span.searchTarget }] : []),
    ...(span.searchHitCount !== null
      ? [{ label: "Results", value: formatInteger(span.searchHitCount) }]
      : []),
    ...(span.serviceName ? [{ label: "Service", value: span.serviceName }] : []),
  ];
  const toolArguments = span.attributes["gen_ai.tool.call.arguments"];
  const toolResult = span.attributes["gen_ai.tool.call.result"];

  return (
    <section
      aria-label="Selected step"
      className="flex flex-col gap-4 rounded-lg border border-line p-4"
      data-inspector
    >
      <header className="flex flex-col gap-1">
        <span className="text-xs text-fg-subtle">{STEP_KIND_LABEL[kind]}</span>
        <h2 className="text-sm font-semibold break-words text-fg">{stepTitle(span)}</h2>
        <StatusDot tone={failed ? "danger" : "success"} label={failed ? "Failed" : "Completed"} />
      </header>

      {errorType ? (
        <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-ui text-fg">
          Error <code className="font-mono text-xs text-fg">{errorType}</code>
        </p>
      ) : null}

      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-ui">
        {facts.map((fact) => (
          <div key={fact.label} className="contents">
            <dt className="text-fg-subtle">{fact.label}</dt>
            <dd className="min-w-0 break-words text-fg tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>

      {toolArguments !== undefined ? <Payload label="Arguments" value={toolArguments} /> : null}
      {toolResult !== undefined ? <Payload label="Result" value={toolResult} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={onShowDetails}>
          All attributes
        </Button>
        {runtimeEventsRoot && span.eventId ? (
          <Link
            href={`${runtimeEventsRoot}?event=${encodeURIComponent(span.eventId)}`}
            className="inline-flex items-center gap-1 text-ui text-fg-muted underline decoration-line-strong underline-offset-4 hover:text-fg"
          >
            SDK event
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        ) : null}
      </div>
    </section>
  );
}

function Payload({ label, value }: { label: string; value: unknown }) {
  const text = formatAttributeValue(value);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-fg-subtle">{label}</span>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <pre className="max-h-40 overflow-auto rounded-md border border-line bg-rail p-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-fg">
        {text}
      </pre>
    </div>
  );
}

/**
 * Everything the span carried, raw (the Details tab): identity, then every
 * attribute by its own name. For the specialist; the inspector says it plainly.
 */
export function SpanDetails({ span, traceId }: { span: TraceSpanView; traceId: string }) {
  const identity: { label: string; value: string; copy?: boolean }[] = [
    { label: "Span name", value: span.name },
    { label: "Span ID", value: span.spanId, copy: true },
    {
      label: "Parent span ID",
      value: span.parentSpanId ?? "None (root)",
      copy: Boolean(span.parentSpanId),
    },
    { label: "Trace ID", value: traceId, copy: true },
    { label: "Kind", value: formatSpanKind(span.kind) },
    { label: "Status", value: formatSpanStatus(span.statusCode) },
    { label: "Started", value: formatTimestamp(span.startedAt) },
    { label: "Duration", value: formatDuration(span.durationMs) },
    ...(span.operationName ? [{ label: "Operation", value: span.operationName }] : []),
    ...(span.providerName ? [{ label: "Provider", value: span.providerName }] : []),
    ...(span.serviceName ? [{ label: "Service", value: span.serviceName }] : []),
    ...(span.scopeName ? [{ label: "Instrumentation", value: span.scopeName }] : []),
    ...(span.experimentName ? [{ label: "Experiment", value: span.experimentName }] : []),
    ...(span.experimentArm ? [{ label: "Variant", value: span.experimentArm }] : []),
  ];
  return (
    <div className="flex flex-col gap-8" data-span-details>
      <KeyValues
        title="Identity"
        rows={identity.map((row) => ({
          key: row.label,
          value: row.value,
          copy: row.copy,
          mono: row.copy,
        }))}
      />
      <SpanAttributesList
        title="Attributes"
        attributes={span.attributes}
        truncated={span.attrsTruncated}
        empty="This span carried no attributes."
      />
      {Object.keys(span.experimentAttrs).length > 0 ? (
        <SpanAttributesList title="Experiment attributes" attributes={span.experimentAttrs} />
      ) : null}
    </div>
  );
}

/** Every attribute by its own name, each value copyable. Shared by spans and logs. */
export function SpanAttributesList({
  title,
  attributes,
  truncated = false,
  empty = "None.",
}: {
  title: string;
  attributes: Readonly<Record<string, unknown>>;
  truncated?: boolean;
  empty?: string;
}) {
  return (
    <KeyValues
      title={title}
      note={
        truncated ? "Some attributes were cut at ingest to stay within the size limit." : undefined
      }
      empty={empty}
      rows={sortedEntries(attributes).map(([key, value]) => ({
        key,
        value: formatAttributeValue(value),
        copy: true,
        mono: true,
        rawKey: true,
      }))}
    />
  );
}

function KeyValues({
  title,
  rows,
  note,
  empty,
}: {
  title: string;
  rows: readonly { key: string; value: string; copy?: boolean; mono?: boolean; rawKey?: boolean }[];
  note?: string;
  empty?: string;
}) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {note ? <p className="text-xs text-fg-subtle">{note}</p> : null}
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">{empty}</p>
      ) : (
        <dl className="rounded-lg border border-line">
          {rows.map((row) => (
            <div
              key={row.key}
              className="grid grid-cols-[minmax(10rem,18rem)_minmax(0,1fr)_auto] items-start gap-3 border-b border-line px-3 py-1.5 last:border-b-0"
            >
              {/* One 20 px line plus 4 px above and below matches the 28 px copy
                  button, so a single-line row reads level with it. */}
              {/* The line height goes after the size: a later size would drop it in the class merge. */}
              <dt
                className={cn(
                  "min-w-0 py-1 break-all text-fg-subtle",
                  row.rawKey ? "font-mono text-xs" : "text-ui",
                  "leading-5",
                )}
              >
                {row.key}
              </dt>
              <dd
                className={cn(
                  "max-h-48 min-w-0 overflow-auto py-1 break-words whitespace-pre-wrap text-fg",
                  row.mono ? "font-mono text-xs" : "text-ui",
                  "leading-5",
                )}
              >
                {row.value}
              </dd>
              {/* Rows without a copy button keep its room, so every row has one height. */}
              {row.copy ? (
                <CopyButton text={row.value} label={`Copy ${row.key}`} />
              ) : (
                <span aria-hidden className="size-7" />
              )}
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function sortedEntries(attributes: Readonly<Record<string, unknown>>): [string, unknown][] {
  // Codepoint order: the same on the server and in every browser locale.
  return Object.entries(attributes).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}
