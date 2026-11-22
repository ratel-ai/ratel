"use server";

import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { createCalibrationQueries } from "@/lib/synthesis/experiments/calibration-queries";
import { createCalibrationService } from "@/lib/synthesis/experiments/calibration-service";
import type { ComparisonPage } from "@/lib/synthesis/experiments/calibration-types";
import { resolveComparisonBrowserView } from "@/lib/synthesis/traces/calibration-view";
import { resolveTraceListView } from "@/lib/synthesis/traces/view";

export interface ComparisonPageRequest {
  projectId: string;
  experimentName: string;
  /** The browser's URL parameters, re-resolved server-side (never trusted). */
  search: Record<string, string>;
}

/**
 * Load one page of the comparison browser without re-rendering the whole
 * calibration page. The browser keeps its own filter/pagination state, so a
 * filter change costs one comparison query instead of every window aggregate on
 * the page — and the client can serve pages it already holds from its cache.
 *
 * Every input is re-resolved through the same resolvers the page uses: the
 * caller's project scope, flags and window bounds are authoritative here, not
 * whatever the client posted.
 *
 * Owned (ADR-0030): the project comes from the console scope; null when it is not the
 * caller's.
 */
export async function loadComparisonPageAction(
  request: ComparisonPageRequest,
): Promise<ComparisonPage | null> {
  if (!isDbConfigured()) return null;

  const scope = await findProjectScope(request.projectId);
  if (!scope) return null;
  const view = resolveTraceListView(request.search);

  const window = { since: view.range.since, until: view.range.until };
  const browser = resolveComparisonBrowserView(request.search);
  return loadOrFallback({
    operation: "calibration_comparison_page",
    distinctId: `project:${scope.project.id}`,
    fallback: null as ComparisonPage | null,
    load: () =>
      withStatementTimeout((db) =>
        createCalibrationService(createCalibrationQueries(db)).listComparisonPage(
          scope.project.id,
          request.experimentName,
          window,
          {
            selection: browser.selection,
            limit: browser.pageSize,
            offset: browser.offset,
          },
        ),
      ),
  });
}
