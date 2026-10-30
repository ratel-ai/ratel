"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { CodeBlock } from "@ratel/design-system/code";
import { Callout } from "@ratel/design-system/states";
import type { TraceContentView } from "@/lib/synthesis/traces/content-view";
import { formatAttributeValue } from "@/lib/synthesis/traces/format";
import { conversationMessages, ROLE_LABEL } from "@/lib/synthesis/traces/v2/conversation";
import { formatDuration } from "@/lib/synthesis/traces/v2/format";
import { CONTENT_CAPTURE_DOCS } from "./RunPanel";

/**
 * The run as it was spoken: each message once, in order, then the tool calls
 * with what went in and what came back. Without content capture it says so
 * and still lists the tool calls it can see.
 */
export function TraceConversation({ content }: { content: TraceContentView }) {
  const messages = conversationMessages(content.messages);
  return (
    <div className="flex max-w-3xl flex-col gap-8" data-conversation>
      {!content.contentCaptured ? (
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
          Capture is off by default to protect your users&apos; data. Turn it on in your SDK to read
          what this run was asked and answered.
        </Callout>
      ) : null}

      {messages.length > 0 ? (
        <section aria-label="Messages" className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-fg">Messages</h2>
          <ol className="flex flex-col gap-4">
            {messages.map((message) => (
              <li key={message.id} className="flex flex-col gap-1.5" data-role={message.role}>
                <span className="text-xs font-medium text-fg-subtle">
                  {ROLE_LABEL[message.role]}
                </span>
                <p
                  className={cn(
                    "max-h-96 overflow-auto rounded-lg border border-line px-3 py-2.5 text-sm whitespace-pre-wrap break-words text-fg",
                    message.role === "user" ? "bg-raised" : "bg-app",
                  )}
                >
                  {message.text}
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section aria-label="Tool calls" className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-fg">Tool calls</h2>
        {content.toolCalls.length === 0 ? (
          <p className="text-sm text-fg-muted">This run called no tools.</p>
        ) : (
          <ol className="flex flex-col gap-5">
            {content.toolCalls.map((call, index) => (
              <li key={`${call.id}:${index}`} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui">
                  <span className="font-medium text-fg">{call.name}</span>
                  <span className="text-fg-muted tabular-nums">
                    {formatDuration(call.durationMs)}
                  </span>
                  {call.statusCode === 2 ? <StatusDot tone="danger" label="Failed" /> : null}
                </div>
                {call.arguments !== null ? (
                  <CodeBlock
                    caption="Arguments"
                    samples={[{ label: "JSON", code: pretty(call.arguments) }]}
                  />
                ) : null}
                {call.result !== null ? (
                  <CodeBlock
                    caption="Result"
                    samples={[{ label: "JSON", code: pretty(call.result) }]}
                  />
                ) : null}
                {call.arguments === null && call.result === null ? (
                  <p className="text-xs text-fg-subtle">
                    Arguments and result weren&apos;t captured.
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function pretty(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2) ?? formatAttributeValue(value);
  } catch {
    return formatAttributeValue(value);
  }
}
