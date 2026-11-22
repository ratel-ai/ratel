"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { CopyButton } from "@ratel/design-system/code";
import { ArrowUpRight, SquarePlay } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  countryLabel,
  harnessWithVersion,
  reportedLabel,
  transportLabel,
} from "@/components/console/clients/labels";
import {
  formatAttributeValue,
  formatSpanKind,
  formatSpanStatus,
} from "@/lib/synthesis/traces/format";
import { isUnpricedCall } from "@/lib/synthesis/traces/v2/cost-label";
import {
  formatDuration,
  formatInteger,
  formatMoney,
  formatTimestamp,
} from "@/lib/synthesis/traces/v2/format";
import { isRoutineHook, type RunEvent, spanWait } from "@/lib/synthesis/traces/v2/run-metrics";
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
  events,
  showWait = false,
  openInSandboxHref = null,
  children,
}: {
  span: TraceSpanView;
  offsetMs: number;
  runtimeEventsRoot: string | null;
  onShowDetails: () => void;
  /** The step's run events (AOBS-7): compactions, permission decisions, hooks and waits. */
  events?: readonly RunEvent[];
  /** Say in words that the step waited for a person (AOBS-7). */
  showWait?: boolean;
  /** A recorded sandbox item opens in its sandbox's playground (RC-1103, `cloud-sandboxes`). */
  openInSandboxHref?: string | null;
  /** The span's content pane: input, output and raw attributes (RC-412). */
  children: ReactNode;
}) {
  const kind = stepKind(span);
  const failed = span.statusCode === 2;
  const tokens = (span.inputTokens ?? 0) + (span.outputTokens ?? 0);
  const errorType = failed ? stringAttribute(span.attributes, "error.type") : null;
  const wait = showWait ? spanWait(span.attributes) : null;
  // The routine hooks last: a compaction or a wait must not hide below them.
  const listedEvents = events
    ? [...events.filter((event) => !isRoutineHook(event)), ...events.filter(isRoutineHook)]
    : [];
  const facts: { label: string; value: ReactNode }[] = [
    { label: "Duration", value: formatDuration(span.durationMs) },
    ...(wait
      ? [
          {
            label: "Waited",
            value: `${wait.humanMs !== null ? `${formatDuration(wait.humanMs)} for a person` : "For a person"}: ${[wait.kind, wait.label.toLowerCase()].filter(Boolean).join(", ")}`,
          },
        ]
      : []),
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
    ...(isUnpricedCall(span) ? [{ label: "Cost", value: "Unpriced" }] : []),
    ...(span.searchQuery ? [{ label: "Query", value: span.searchQuery }] : []),
    ...(span.searchTarget ? [{ label: "Searched", value: span.searchTarget }] : []),
    ...(span.searchHitCount !== null
      ? [{ label: "Results", value: formatInteger(span.searchHitCount) }]
      : []),
    ...(span.serviceName ? [{ label: "Service", value: span.serviceName }] : []),
  ];

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

      {listedEvents.length > 0 ? (
        <div className="flex flex-col gap-2" data-span-events>
          <h3 className="text-xs font-medium text-fg-subtle">Events</h3>
          <ol className="flex max-h-48 flex-col gap-1.5 overflow-auto text-ui">
            {listedEvents.map((event, index) => (
              <li
                key={`${event.kind}:${event.offsetMs}:${index}`}
                className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3"
              >
                <span className="text-fg-subtle tabular-nums">
                  +{formatDuration(event.offsetMs)}
                </span>
                <span className="min-w-0 break-words text-fg">
                  {event.label}
                  {event.detail ? <span className="text-fg-muted"> {event.detail}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <ClientFacts span={span} />

      {children}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={onShowDetails}>
          All attributes
        </Button>
        {openInSandboxHref ? (
          <Link
            href={openInSandboxHref}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <SquarePlay aria-hidden className="size-3.5" />
            Open in sandbox
          </Link>
        ) : null}
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

/**
 * Who called an MCP server's span (RC-773, RC-774): the client, its country,
 * the transport and the protocol version. No IP row: ingest reads the
 * country from the caller's IP and drops the IP (RP-138), so no span has one.
 */
function ClientFacts({ span }: { span: TraceSpanView }) {
  const facts: { label: string; value: string }[] = [
    ...(span.harness || span.harnessVersion
      ? [{ label: "Client", value: harnessWithVersion(span.harness, span.harnessVersion) }]
      : []),
    ...(span.geoCountry ? [{ label: "Country", value: countryLabel(span.geoCountry) }] : []),
    ...(span.mcpTransport
      ? [{ label: "Transport", value: transportLabel(span.mcpTransport) }]
      : []),
    ...(span.mcpProtocolVersion
      ? [{ label: "Protocol", value: reportedLabel(span.mcpProtocolVersion) }]
      : []),
  ];
  if (facts.length === 0) return null;
  return (
    <section aria-label="Client" className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-fg-subtle">Client</h3>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-ui">
        {facts.map((fact) => (
          <div key={fact.label} className="contents">
            <dt className="text-fg-subtle">{fact.label}</dt>
            <dd className="min-w-0 break-words text-fg tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
