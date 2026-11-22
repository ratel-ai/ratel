import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { readTimeoutMs, withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  getPivotGroupBy,
  PIVOT_GROUP_LIMIT,
  type PivotGroupBy,
} from "@/lib/synthesis/pivots/group-by";
import { pivotGroupRowViews } from "@/lib/synthesis/pivots/group-by-view";
import type { PivotFilterOption } from "@/lib/synthesis/traces/v2/filters";
import { resolveTraceListView } from "@/lib/synthesis/traces/view";
import { type OverviewWindow, overviewRangeParam } from "@/lib/views/home/overview-model";
import { PivotBreakdownTable } from "./PivotBreakdownTable";

/**
 * Overview's group-by of one pivot (RC-886, `cloud-pivots`): which values of
 * the picked pivot drive runs, errors, latency and cost in the window. The page
 * renders it inside a Suspense boundary, so the rest of Overview never waits
 * for it. A slow or failed read degrades to a notice, never the page.
 */
export async function PivotBreakdown({
  projectId,
  root,
  window,
  pivots,
  pivot,
  now,
}: {
  projectId: string;
  root: string;
  window: OverviewWindow;
  pivots: readonly PivotFilterOption[];
  pivot: PivotFilterOption;
  now: Date;
}) {
  const { range } = resolveTraceListView({ range: overviewRangeParam(window) }, now);
  // The 30-day group-by on 1.2M summary rows takes 5 to 7 s on a loaded laptop (RC-886, measured in the
  // PR): over the 5 s supplementary bound, so it reads under the app's read timeout and streams in.
  const groupBy = await loadOrFallback<PivotGroupBy | null>({
    operation: "pivot_group_by",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () =>
      withStatementTimeout(
        (db) =>
          getPivotGroupBy(projectId, pivot.key, { since: range.since, until: range.until }, db),
        {
          operation: "pivot_group_by",
          timeoutMs: readTimeoutMs(),
        },
      ),
  });
  return (
    <Section
      title={`Runs by ${pivot.label.toLowerCase()}`}
      description={`The top ${PIVOT_GROUP_LIMIT} values in the last ${window} days. The rest are in Other.`}
    >
      {groupBy ? (
        <PivotBreakdownTable
          pivots={pivots}
          pivotKey={pivot.key}
          pivotLabel={pivot.label}
          rows={pivotGroupRowViews(groupBy, pivot.key, root)}
        />
      ) : (
        <Callout tone="danger" title="This table did not load">
          Reading this window took too long. The rest of the page still works.
        </Callout>
      )}
    </Section>
  );
}

/** What the table shows while its read runs. */
export function PivotBreakdownLoading({ pivot }: { pivot: PivotFilterOption }) {
  return (
    <Section title={`Runs by ${pivot.label.toLowerCase()}`}>
      <p className="text-ui text-fg-subtle" aria-busy="true">
        Reading runs by {pivot.label.toLowerCase()}…
      </p>
    </Section>
  );
}
