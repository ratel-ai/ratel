import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";

/**
 * Adaptive labelling (RC-392): the decision engine labels a batch, the number is re-estimated,
 * and it labels more only while the number's margin is not met (`adaptive.ts`); topic and task
 * decisions keep their answers across option changes behind a re-asked audit (`carry.ts`).
 *
 * Owned (ADR-0030): upstream evaluates `cloud-adaptive-labelling` per `project:<id>` through its
 * flag service in the worker. Here it is the deployment switch `FF_ADAPTIVE_LABELLING` (off by
 * default). The names and arguments stay upstream's so the job call sites are its.
 */
export const ADAPTIVE_LABELLING_FLAG = "FF_ADAPTIVE_LABELLING" as const;

type Env = Record<string, string | undefined>;

const logger = getLogger("labelling/gate");

export async function adaptiveLabellingEnabled(
  _projectId: string,
  _organization: unknown,
  env: Env = process.env,
): Promise<boolean> {
  return experimentalFeatureEnabled(ADAPTIVE_LABELLING_FLAG, env);
}

/**
 * The switch for one project, from a job that knows only the project. A failed read is logged and
 * reads as off: the switch only changes how much is asked, never whether the job completes.
 */
export async function adaptiveLabellingForProject(
  projectId: string,
  isEnabled: (
    projectId: string,
    organization: unknown,
  ) => Promise<boolean> = adaptiveLabellingEnabled,
  loadOrganization: (projectId: string) => Promise<unknown> = getOrganizationByProjectId,
): Promise<boolean> {
  try {
    return await isEnabled(projectId, await loadOrganization(projectId));
  } catch (error) {
    logger.warn({ err: error, project_id: projectId }, "adaptive labelling flag read failed");
    return false;
  }
}
