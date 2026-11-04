import { isDbConfigured } from "@/lib/platform/db/client";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { loadSectionProgress } from "./load";
import type { SectionProgress } from "./model";
import { type AnalysisSection, sectionJobKinds } from "./sections";

const logger = getLogger("freshness/page");

/**
 * A page's analysis progress for its server render (RC-210), so the header's
 * "Updating" and a "working on it" empty state are right on first paint.
 * Supplementary: a slow or failed read answers null and the page renders as
 * before, while the header's own poll picks it up.
 */
export async function loadPageProgress(
  projectId: string,
  section: AnalysisSection,
): Promise<SectionProgress | null> {
  if (!isDbConfigured()) return null;
  try {
    return await withStatementTimeout(
      (db) => loadSectionProgress(db, projectId, sectionJobKinds(section)),
      {
        operation: "analysis_section_progress",
        timeoutMs: supplementaryReadTimeoutMs(),
      },
    );
  } catch (err) {
    logger.error({ err, project_id: projectId, section }, "analysis section progress read failed");
    return null;
  }
}
