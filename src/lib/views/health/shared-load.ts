import type { SharedHealthLink } from "@/lib/contracts/composition";
import { type AgentHealthLimits, getAgentHealthLimits } from "@/lib/platform/entitlements";
import {
  applyPlanLimits,
  type HealthPageModel,
  parseWindowDays,
} from "@/lib/readings/trace-signals/view";
import type { WorkflowLabels } from "@/lib/readings/trace-signals/workflows/name";
import {
  loadHealthPageModel,
  type PageModelDeps,
  workflowLabelsFor,
} from "@/lib/views/health/page-model";
import { publicHealthModel, publicWorkflowLabels } from "@/lib/views/health/public-model";

/**
 * The model behind a public share link (upstream's `share/load.ts`). Owned (ADR-0030): the link,
 * its token and its table are the edition's, so the token is resolved by `EditionUi.HealthShare`
 * and passed in; there is no feature flag to check. The model, its redaction and the cache are
 * upstream's.
 */

/** What a shared page renders: the redacted model and who it belongs to. */
export interface SharedHealth {
  linkId: string;
  projectId: string;
  organizationId: string;
  projectName: string;
  organizationName: string;
  model: HealthPageModel;
}

/**
 * Recently built models by link, so a busy link costs one model build a
 * minute instead of one per view. Only the model is cached: the token is
 * checked on every request, so turning a link off is immediate.
 */
export const SHARED_MODEL_TTL_MS = 60_000;
const SHARED_MODEL_CACHE_MAX = 200;

export interface ModelCache {
  /**
   * The model for `key`: the cached one while fresh, else `build()`'s. The
   * promise is what is cached, so requests that arrive while a build runs
   * share it instead of each starting their own; a failed build is dropped
   * at once so the next request tries again.
   */
  get(key: string, now: number, build: () => Promise<HealthPageModel>): Promise<HealthPageModel>;
}

export function createModelCache(
  ttlMs = SHARED_MODEL_TTL_MS,
  max = SHARED_MODEL_CACHE_MAX,
): ModelCache {
  const entries = new Map<string, { at: number; model: Promise<HealthPageModel> }>();
  return {
    get(key, now, build) {
      const hit = entries.get(key);
      if (hit && now - hit.at <= ttlMs) return hit.model;
      const model = build();
      entries.delete(key);
      entries.set(key, { at: now, model });
      model.catch(() => {
        if (entries.get(key)?.model === model) entries.delete(key);
      });
      // Oldest first: drop from the front once over the cap.
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return model;
    },
  };
}

export interface SharedHealthDeps {
  /** The edition's `HealthShare.resolve`: the live link behind a token, or null. */
  resolve: (token: string) => Promise<SharedHealthLink | null>;
  getLimits: (organization: SharedHealthLink["organization"]) => AgentHealthLimits;
  loadModel: (input: {
    projectId: string;
    windowDays: HealthPageModel["windowDays"];
    limits: AgentHealthLimits;
  }) => Promise<HealthPageModel>;
  cache?: ModelCache;
  now?: () => number;
}

/**
 * What a shared page or a PDF reads, beyond the member page's model: nothing
 * copied from users' words. Example runs are not read at all, and the ask
 * insights are those asks grouped, so they are not loaded either.
 *
 * Model-written workflow names stay: they are short, general names of the
 * kind of request ("Close out a release"), written to fit every run of the
 * workflow rather than one ask, and without them a reader only sees tool
 * chains. Their descriptions are dropped here, and again in `publicHealthModel`.
 */
export function publicLoadOverrides(
  limits: AgentHealthLimits,
  readLabels: (projectId: string) => Promise<WorkflowLabels> = workflowLabelsFor,
): Partial<PageModelDeps> {
  return {
    getLimits: async () => ({ ...limits, agentHealthEvidenceTurns: 0 }),
    getLabels: async (projectId) => publicWorkflowLabels(await readLabels(projectId)),
    getInsights: async () => null,
  };
}

const sharedCache = createModelCache();

/** The loader's real reads; the page supplies `resolve` from the edition's slot. */
export function sharedHealthDeps(resolve: SharedHealthDeps["resolve"]): SharedHealthDeps {
  return {
    resolve,
    cache: sharedCache,
    getLimits: (organization) => getAgentHealthLimits(organization),
    loadModel: ({ projectId, windowDays, limits }) =>
      loadHealthPageModel(
        { projectId, windowDays },
        process.env.NODE_ENV,
        publicLoadOverrides(limits),
      ),
  };
}

/**
 * The shared page's model, or null. Malformed, unknown and revoked tokens all
 * return the same null, so the page answers each with the same 404 and a
 * visitor learns nothing about which it was.
 */
export async function loadSharedHealth(
  token: string,
  deps: SharedHealthDeps,
): Promise<SharedHealth | null> {
  const link = await deps.resolve(token);
  if (!link) return null;
  const limits = deps.getLimits(link.organization);
  // The window chosen when the link was made, cut to the plan as it is now.
  const windowDays = parseWindowDays(String(link.windowDays), limits.agentHealthWindowDays);
  const now = deps.now?.() ?? Date.now();
  const key = `${link.linkId}:${windowDays}:${limits.agentHealthSignalsShown}`;
  const build = async () => {
    const loaded = await deps.loadModel({ projectId: link.project.id, windowDays, limits });
    return publicHealthModel(applyPlanLimits(loaded, { ...limits, agentHealthEvidenceTurns: 0 }));
  };
  const model = await (deps.cache ? deps.cache.get(key, now, build) : build());
  return {
    linkId: link.linkId,
    projectId: link.project.id,
    organizationId: link.organization.id,
    projectName: link.project.name,
    organizationName: link.organization.name,
    model,
  };
}
