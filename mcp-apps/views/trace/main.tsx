"use client";

import { Button } from "@ratel/design-system/button";
/**
 * A trace: the console's own TraceView, embedded as the session replay's Trace
 * view embeds it (its numbers, timeline, step inspector, conversation and
 * details), from the trace page's own props in get_trace's `view`. Without
 * them (a host that passed the text only) it reads as the generic detail.
 */
import { useMemo } from "react";
import { TraceView } from "@/components/console/traces/TraceView";
import { useRatelView } from "../../shell/bridge";
import { parseDetailConfig } from "../../shell/config";
import { DetailBody, DetailHeader } from "../../shell/detail-body";
import { mountView } from "../../shell/mount";
import type { ToolSuccess } from "../../shell/state";
import { ViewFrame } from "../../shell/view-frame";
import { detailBindings } from "../detail/bindings";
import view from "./bindings";
import { readTraceView } from "./trace";

const fallback = detailBindings.find((binding) => binding.tool === "get_trace")!;

function Trace({ result }: { result: ToolSuccess }) {
  const ratel = useRatelView();
  const props = useMemo(() => readTraceView(result), [result]);
  const config = useMemo(() => parseDetailConfig(fallback.tool, fallback.config), []);
  if (!props) {
    return (
      <div className="flex flex-col gap-4">
        <header className="border-b border-line pb-3">
          <DetailHeader config={config} data={result.data} />
        </header>
        <DetailBody config={config} result={result} />
      </div>
    );
  }
  const href = `/project/${encodeURIComponent(props.projectId)}/traces/${encodeURIComponent(props.traceId)}`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => ratel.openInConsole(href)}>
          Open in Ratel
        </Button>
      </div>
      <TraceView {...props} embedded fetchRaw={false} />
    </div>
  );
}

mountView(
  { name: "trace", bindings: view.bindings },
  <ViewFrame>{(result) => <Trace result={result} />}</ViewFrame>,
);
