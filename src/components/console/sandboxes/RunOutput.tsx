"use client";

import { Badge, StatusDot } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import { DotLoaderLazy } from "@ratel/design-system/dot-loader-lazy";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatDuration, formatInteger } from "@/lib/synthesis/traces/v2/format";
import { configPillText, type RunViewState } from "@/lib/views/sandboxes/playground-state";
import { runStatus, traceHref } from "./types";

/**
 * The streamed output of the current run: live text, log lines and tool calls
 * as they arrive, then the final output as JSON, the tokens, the latency and
 * the link to its trace. Only what the run sent: nothing is made up.
 */
export function RunOutput({
  projectId,
  view,
  productionHash,
}: {
  projectId: string;
  view: RunViewState;
  productionHash: string | null;
}) {
  if (view.phase === "idle" && !view.runId) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-ui text-fg-muted">
        Press Run to see the output here.
      </p>
    );
  }
  const status = runStatus(view.phase === "starting" ? "queued" : view.status);
  const live = view.phase === "starting" || view.phase === "live";
  const pill = view.configHash
    ? configPillText({ changed: view.overrides, configHash: view.configHash, productionHash })
    : null;
  const tokens = view.usage ? (view.usage.inputTokens ?? 0) + (view.usage.outputTokens ?? 0) : null;

  return (
    <div className="flex flex-col gap-4" aria-live="polite" aria-busy={live}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-2">
          {live ? <DotLoaderLazy label="Running" size="sm" /> : null}
          <StatusDot tone={status.tone} label={status.label} />
        </span>
        {pill ? <Badge>{pill}</Badge> : null}
        {view.latencyMs !== null ? (
          <span className="text-xs text-fg-subtle tabular-nums">
            {formatDuration(view.latencyMs)}
          </span>
        ) : null}
        {view.usage ? (
          <span
            className="text-xs text-fg-subtle tabular-nums"
            title={`${formatInteger(view.usage.inputTokens ?? 0)} in, ${formatInteger(view.usage.outputTokens ?? 0)} out`}
          >
            {formatInteger(tokens)} tokens ({formatInteger(view.usage.inputTokens ?? 0)} in,{" "}
            {formatInteger(view.usage.outputTokens ?? 0)} out)
          </span>
        ) : null}
        {view.traceId ? (
          <Link
            href={traceHref(projectId, view.traceId)}
            className="ml-auto inline-flex items-center gap-1 rounded-sm text-ui text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            View trace
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>

      {view.error ? (
        <p className="rounded-md bg-danger-subtle px-3 py-2 text-ui text-danger">{view.error}</p>
      ) : null}

      {view.text ? <OutputBlock title="Text">{view.text}</OutputBlock> : null}

      {view.tools.length > 0 ? (
        <OutputBlock title="Tool calls">
          {view.tools.map((tool) => (
            <span key={tool.callId} className="block">
              <span className="text-fg">{tool.tool}</span>
              {tool.mode ? <span className="text-fg-subtle"> · {tool.mode}</span> : null}
              <span className="text-fg-muted"> {JSON.stringify(tool.args)}</span>
              {tool.done ? (
                <span className={tool.isError ? "text-danger" : "text-fg-muted"}>
                  {" "}
                  → {JSON.stringify(tool.result)}
                </span>
              ) : (
                <span className="text-fg-subtle"> …</span>
              )}
            </span>
          ))}
        </OutputBlock>
      ) : null}

      {view.logs.length > 0 ? (
        <OutputBlock title="Logs">
          {view.logs.map((line, index) => (
            <span key={index} className="block">
              <span
                className={cn(
                  line.level === "error"
                    ? "text-danger"
                    : line.level === "warn"
                      ? "text-warning"
                      : "text-fg-subtle",
                )}
              >
                {line.level.padEnd(5)}
              </span>{" "}
              {line.message}
            </span>
          ))}
        </OutputBlock>
      ) : null}

      {view.phase === "ended" && view.status === "ok" ? (
        <OutputBlock title="Output">{JSON.stringify(view.output, null, 2)}</OutputBlock>
      ) : null}
    </div>
  );
}

function OutputBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-fg-muted">{title}</h3>
      <pre
        tabIndex={0}
        className="max-h-96 overflow-auto rounded-lg border border-line bg-rail p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {children}
      </pre>
    </section>
  );
}
