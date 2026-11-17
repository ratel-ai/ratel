"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { CodeBlock } from "@ratel/design-system/code";
import { Callout } from "@ratel/design-system/states";
import { SegmentedControl, Tabs } from "@ratel/design-system/tabs";
import { useMemo, useState } from "react";
import type { RawSpanView } from "@/lib/ingest/otlp-raw/trace-raw-route";
import type { TraceContentView } from "@/lib/synthesis/traces/content-view";
import { ROLE_LABEL } from "@/lib/synthesis/traces/v2/conversation";
import { formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import {
  buildSpanIO,
  type SpanIO,
  type SpanIOInput,
  type SpanMessage,
} from "@/lib/synthesis/traces/v2/span-io";
import type { TraceSpanView } from "@/lib/synthesis/traces/view";
import { CONTENT_CAPTURE_DOCS } from "./RunPanel";
import { SpanAttributesList } from "./SpanInspector";
import { pretty } from "./TraceConversation";

export type RawState = "loading" | "ready" | "error";
type Mode = "formatted" | "json";

const MODES = [
  { value: "formatted", label: "Formatted" },
  { value: "json", label: "JSON" },
] as const satisfies readonly { value: Mode; label: string }[];

/**
 * The selected span's content (RC-412, `cloud-trace-views-v3`): its input and
 * output (messages for a model call, arguments and result for a tool call),
 * then every attribute, the resource and the events. The raw export wins over
 * the stored span; the run's payload fills in what both lack. Formatted or
 * JSON, for both tabs.
 */
export function SpanIOPanel({
  span,
  raw,
  rawState,
  payload,
  descendants = [],
  turnHasContent = false,
  onSelectSpan,
}: {
  span: TraceSpanView;
  raw: RawSpanView | null;
  rawState: RawState;
  payload: TraceContentView | null;
  /** The span's descendants in timeline order, raw attributes merged (RC-501). */
  descendants?: readonly SpanIOInput[];
  /** Whether the turn carries any message content, on its spans or its payload. */
  turnHasContent?: boolean;
  onSelectSpan?: (spanId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("formatted");
  const attributes = useMemo(
    () => ({ ...span.attributes, ...raw?.attributes }),
    [span.attributes, raw],
  );
  const io = useMemo(
    () =>
      buildSpanIO(
        { spanId: span.spanId, spanClass: span.spanClass, attributes },
        payload,
        descendants,
      ),
    [span.spanId, span.spanClass, attributes, payload, descendants],
  );

  return (
    <div className="flex flex-col gap-3" data-span-io={io.kind}>
      <div className="flex justify-end">
        <SegmentedControl label="Show as" options={MODES} value={mode} onValueChange={setMode} />
      </div>
      <Tabs
        items={[
          {
            value: "io",
            label: "Input & output",
            content:
              mode === "json" ? (
                <JsonBlock caption="Input & output" value={ioJson(io)} />
              ) : (
                <IOFormatted
                  io={io}
                  rawState={rawState}
                  turnHasContent={turnHasContent}
                  onSelectSpan={onSelectSpan}
                />
              ),
          },
          {
            value: "attributes",
            label: "Attributes",
            content:
              mode === "json" ? (
                <JsonBlock
                  caption="Span"
                  value={{
                    attributes,
                    resource: raw?.resourceAttributes ?? null,
                    events: raw?.events ?? null,
                    scope: raw?.scopeName ?? span.scopeName,
                  }}
                />
              ) : (
                <AttributesFormatted
                  attributes={attributes}
                  raw={raw}
                  rawState={rawState}
                  truncated={span.attrsTruncated}
                />
              ),
          },
        ]}
      />
    </div>
  );
}

function IOFormatted({
  io,
  rawState,
  turnHasContent,
  onSelectSpan,
}: {
  io: SpanIO;
  rawState: RawState;
  turnHasContent: boolean;
  onSelectSpan?: (spanId: string) => void;
}) {
  if (io.kind === "none") {
    if (rawState === "loading")
      return <p className="text-ui text-fg-muted">Loading the span&apos;s content…</p>;
    // RC-501: "isn't captured" only when the whole turn has no content.
    if (turnHasContent) {
      return (
        <Callout title="This step has no messages of its own">
          The turn&apos;s messages are on its model calls. The Conversation tab shows them all.
        </Callout>
      );
    }
    return (
      <Callout
        title="Message content isn't captured"
        action={
          <a
            href={CONTENT_CAPTURE_DOCS}
            target="_blank"
            rel="noreferrer"
            className="text-ui font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-subtle"
          >
            How to turn it on
          </a>
        }
      >
        This step carried no input or output we can show.
      </Callout>
    );
  }
  const note =
    io.kind === "messages" && io.source === "child" ? (
      <p
        className="flex flex-wrap items-center gap-x-2 text-xs text-fg-subtle"
        data-span-io-source="child"
      >
        This step has no messages of its own. These are from the model call under it.
        {onSelectSpan ? (
          <Button variant="ghost" size="sm" onClick={() => onSelectSpan(io.childSpanId)}>
            Open that model call
          </Button>
        ) : null}
      </p>
    ) : io.source === "payload" ? (
      <p className="text-xs text-fg-subtle">From the turn&apos;s stored model calls.</p>
    ) : null;
  if (io.kind === "tool") {
    return (
      <div className="flex flex-col gap-3">
        {note}
        {io.arguments !== null ? (
          <JsonBlock caption="Arguments" value={io.arguments} />
        ) : (
          <Missing what="Arguments" />
        )}
        {io.result !== null ? (
          <JsonBlock caption="Result" value={io.result} />
        ) : (
          <Missing what="Result" />
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {note}
      <Messages title="Input" messages={io.input} />
      <Messages title="Output" messages={io.output} />
    </div>
  );
}

function Messages({ title, messages }: { title: string; messages: readonly SpanMessage[] }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-fg-subtle">{title}</h3>
      {messages.length === 0 ? (
        <p className="text-ui text-fg-muted">None captured.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {messages.map((message, index) => (
            <li key={index} className="flex flex-col gap-1.5" data-role={message.role}>
              <span className="text-xs font-medium text-fg-subtle">{ROLE_LABEL[message.role]}</span>
              {message.text ? (
                <p
                  className={cn(
                    "max-h-72 overflow-auto rounded-lg border border-line px-3 py-2 text-ui whitespace-pre-wrap break-words text-fg",
                    message.role === "user" ? "bg-raised" : "bg-app",
                  )}
                >
                  {message.text}
                </p>
              ) : null}
              {message.toolCalls.map((call, callIndex) => (
                <JsonBlock key={callIndex} caption={`Calls ${call.name}`} value={call.arguments} />
              ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function AttributesFormatted({
  attributes,
  raw,
  rawState,
  truncated,
}: {
  attributes: Readonly<Record<string, unknown>>;
  raw: RawSpanView | null;
  rawState: RawState;
  truncated: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      {!raw && rawState !== "loading" ? (
        <p className="text-xs text-fg-subtle">
          No raw export is stored for this step: these are the attributes kept at ingest.
        </p>
      ) : null}
      <SpanAttributesList
        title="Attributes"
        attributes={attributes}
        truncated={!raw && truncated}
        empty="This span carried no attributes."
      />
      {raw ? (
        <>
          <SpanAttributesList
            title="Resource"
            attributes={raw.resourceAttributes}
            empty="No resource attributes."
          />
          <section aria-label="Events" className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-fg">Events</h3>
            {raw.events.length === 0 ? (
              <p className="text-sm text-fg-muted">This span recorded no events.</p>
            ) : (
              raw.events.map((event, index) => (
                <SpanAttributesList
                  key={index}
                  title={`${event.name} · ${formatTimestamp(new Date(event.timeUnixMs).toISOString())}`}
                  attributes={event.attributes}
                  empty="No attributes."
                />
              ))
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function JsonBlock({ caption, value }: { caption: string; value: unknown }) {
  return <CodeBlock caption={caption} samples={[{ label: "JSON", code: pretty(value) }]} />;
}

function Missing({ what }: { what: string }) {
  return <p className="text-xs text-fg-subtle">{what}: not captured.</p>;
}

function ioJson(io: SpanIO): unknown {
  if (io.kind === "tool") return { arguments: io.arguments, result: io.result };
  if (io.kind === "messages") return { input: io.input, output: io.output };
  return null;
}
