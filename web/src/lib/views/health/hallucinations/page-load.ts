import { getDb } from "@/lib/platform/db/client";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import {
  buildHallucinationsPage,
  type HallucinationsPageModel,
  uncheckedReason,
} from "@/lib/views/health/hallucinations/page-model";
import {
  countWindowTurns,
  loadCoverage,
  loadLastRead,
  loadPageFindings,
  type PageDb,
} from "@/lib/views/health/hallucinations/page-queries";
import type { HallucinationsQuery } from "@/lib/views/health/hallucinations/paths";
import { loadToolNames, toolNameCheck } from "@/lib/views/health/hallucinations/tool-names";

const DAY_MS = 86_400_000;

export interface LoadHallucinationsPageOptions {
  projectId: string;
  windowDays: WindowDays;
  query: HallucinationsQuery;
  now?: Date;
  db?: PageDb;
}

/** The Hallucinations page for one project and window, from the stored findings. */
export async function loadHallucinationsPage(
  options: LoadHallucinationsPageOptions,
): Promise<HallucinationsPageModel> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDb();
  const window = { from: new Date(now.getTime() - options.windowDays * DAY_MS), to: now };
  const [found, turns, lastRead, coverage] = await Promise.all([
    loadPageFindings(options.projectId, window, db),
    countWindowTurns(options.projectId, window, db),
    loadLastRead(options.projectId, db),
    loadCoverage(options.projectId, window, db),
  ]);
  // Tools the rules have nothing to read for are checked by name instead.
  const toolNames =
    found.findings.length === 0 && turns > 0 && uncheckedReason("tool", coverage) !== null
      ? toolNameCheck(await loadToolNames(options.projectId, window, db))
      : null;
  return buildHallucinationsPage(
    {
      projectId: options.projectId,
      windowDays: options.windowDays,
      findings: found.findings,
      turns,
      lastReadAt: lastRead.at,
      capped: found.capped,
      coverage,
      aliases: lastRead.aliases,
      toolNames,
    },
    options.query,
  );
}
