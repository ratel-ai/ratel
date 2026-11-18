import { composition } from "@/lib/composition";
import type { EditionUi } from "@/lib/contracts/composition";

/** The edition's operator console (`EditionUi.OperatorConsole`). */
export type OperatorConsole = NonNullable<EditionUi["OperatorConsole"]>;

/** The edition's operator console, or undefined in an edition without one (the open-source one). */
export async function operatorConsole(): Promise<OperatorConsole | undefined> {
  return (await composition.ui?.())?.OperatorConsole;
}

export type QualityReportAccessDeps = {
  operatorConsole(): Promise<OperatorConsole | undefined>;
  /** The console's project scope: the project, or a 404 outside the reader's organization. */
  requireProjectScope(projectId: string): Promise<{ project: { id: string } }>;
};

/**
 * Which project the printable Quality report may read, before any read.
 *
 * With an operator console the report is the operator's, as upstream has it behind its
 * platform-admin gate: `authorize` ends the request for anyone else, a member of the project's
 * own organization included, and the operator reads any tenant's project. Without one it is the
 * member's report, scoped to their organization.
 */
export async function qualityReportProjectId(
  requestedProjectId: string,
  deps: QualityReportAccessDeps,
): Promise<string> {
  const operator = await deps.operatorConsole();
  if (operator) {
    await operator.authorize();
    return requestedProjectId;
  }
  const { project } = await deps.requireProjectScope(requestedProjectId);
  return project.id;
}

/**
 * Whether the calibration page links members to the printable report. Upstream links it from its
 * admin console only; with an operator console the report is the operator's, so a member's link
 * would only lead to a 404.
 */
export async function memberQualityReportOffered(
  load: () => Promise<OperatorConsole | undefined> = operatorConsole,
): Promise<boolean> {
  return !(await load());
}
