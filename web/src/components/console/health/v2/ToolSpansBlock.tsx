"use client";

import { Wrench } from "lucide-react";
import { setupPill } from "@/components/console/health/setup-card-model";
import { Guide } from "@/components/console/health/v2/SetupGuidePanel";

const TOOL_SPANS = setupPill({ key: "otel_tool_spans", status: "off", share: 0 });

/**
 * Model calls arrive over OpenTelemetry, but no tool span ever does, so no
 * run can be built and the page would wait forever. Says so, with the tool
 * span guide in place.
 */
export function ToolSpansBlock() {
  return (
    <section
      aria-labelledby="tool-spans-title"
      data-health-state="tool_spans_missing"
      className="flex flex-col gap-4 rounded-lg border border-line bg-raised p-5"
    >
      <div className="flex items-start gap-3">
        <Wrench aria-hidden strokeWidth={1.5} className="mt-0.5 size-5 shrink-0 text-fg-subtle" />
        <div className="flex flex-col gap-1">
          <h2 id="tool-spans-title" className="text-sm font-semibold text-fg">
            Model calls arrive, but no tool calls
          </h2>
          <p className="max-w-2xl text-sm text-fg-muted">
            Every run on this page is built from the tools your agent calls. Send one span per tool
            call and the first reading follows.
          </p>
        </div>
      </div>
      <Guide pill={TOOL_SPANS} />
    </section>
  );
}
