import { Badge, StatusDot } from "@ratel/design-system/badge";
import type { RunnerSummary } from "@/lib/views/sandboxes/page";

/**
 * The caller's `ratel sandbox dev` runner in one line: connected or paused, the short
 * build SHA and a badge when the working tree had changes.
 */
export function RunnerStatus({ runner }: { runner: RunnerSummary | null }) {
  if (!runner) return <StatusDot tone="neutral" label="No runner" />;
  return (
    <span className="inline-flex items-center gap-2">
      <StatusDot
        tone={runner.online ? "success" : "warning"}
        label={runner.online ? "Runner connected" : "Runner paused"}
      />
      {runner.build?.sha ? (
        <code translate="no" className="font-mono text-xs text-fg-subtle" title="Build (git SHA)">
          {runner.build.sha}
        </code>
      ) : null}
      {runner.build?.dirty ? <Badge tone="warning">Uncommitted changes</Badge> : null}
    </span>
  );
}
