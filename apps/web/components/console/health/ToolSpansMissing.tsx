"use client";

import { useState } from "react";
import { SectionPreview, WorkflowPreviewRows } from "@/components/console/health/SectionPreview";
import { SetupGuidePanel } from "@/components/console/health/SetupGuidePanel";
import { setupPill } from "@/components/console/health/setup-card-model";
import type { SetupStack } from "@/components/console/health/setup-guides";

const PILL = setupPill({ key: "otel_tool_spans", status: "off", share: 0 });

/**
 * OpenTelemetry model calls arrive, but no tool span ever does, so no run can
 * be built and the page would wait forever. Says so, shows the tool span guide
 * in place, and an example of the workflows the spans would unlock.
 */
export function ToolSpansMissing() {
  const [stack, setStack] = useState<SetupStack | null>(null);
  return (
    <section
      data-health-state="tool_spans_missing"
      aria-labelledby="tool-spans-missing-title"
      className="card-enter rounded-2xl border border-forest-300 bg-forest-600/40 p-4 sm:p-5"
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-coral">
        Model calls only
      </div>
      <h2
        id="tool-spans-missing-title"
        className="mt-1.5 font-display text-lg font-semibold text-cream"
      >
        Model calls arrive, but no tool calls
      </h2>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-warm-muted">
        Every run on this page is built from the tools your agent calls. Send one span per tool call
        and the first reading follows.
      </p>
      <div className="mt-3">
        <SetupGuidePanel pill={PILL} stack={stack} onStack={setStack} />
      </div>
      <SectionPreview reason="no_tool_calls" lane="otel" showAction={false}>
        <WorkflowPreviewRows />
      </SectionPreview>
    </section>
  );
}
