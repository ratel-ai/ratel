import { z } from "zod";
import { forMember, type MemberAccessDeps, refuse, reply } from "@/lib/console/scope/member-access";
import type { UsageSubject } from "@/lib/contracts/usage-limits";
import {
  type BaselineDeps,
  type ComparisonResult,
  compareWithBaseline,
  pinBaseline,
} from "./baseline";
import { changedCases, otherCases } from "./domain/compare";
import { forKey, type KeyAccess, notFound, readJson, urlOf } from "./experiments-api";
import type { Baseline } from "./ports/baseline-store";

/**
 * The pinned baseline of a project and the comparison with it: with a project key
 * (`protocol/evals/v1`), and for a member of the console. Nothing else pins a baseline.
 */
export type BaselineApiDeps = {
  baselines: () => BaselineDeps;
  track: (
    event: "eval_baseline_pinned" | "eval_baseline_unpinned",
    subject: UsageSubject,
    by: Actor,
  ) => Promise<void>;
  publicUrl: (path: string) => string;
};
export type BaselineKeyDeps = BaselineApiDeps & KeyAccess;
export type BaselineConsoleDeps = BaselineApiDeps & MemberAccessDeps;

type Actor = { pinnedBy: string; externalId?: string; surface: string };

const pinSchema = z.object({ experimentId: z.uuid() });
const COMPARE_STATUS = {
  not_found: 404,
  no_baseline: 409,
  same_experiment: 409,
  not_completed: 409,
  scorers_differ: 409,
} as const;

export function handlePinByKey(request: Request, deps: BaselineKeyDeps): Promise<Response> {
  return forKey(deps, "pin_baseline", (subject, apiKeyId) =>
    pin(request, subject, { pinnedBy: `key:${apiKeyId}`, surface: "api" }, deps),
  );
}

export function handleUnpinByKey(deps: BaselineKeyDeps): Promise<Response> {
  return forKey(deps, "unpin_baseline", (subject, apiKeyId) =>
    unpin(subject, { pinnedBy: `key:${apiKeyId}`, surface: "api" }, deps),
  );
}

export function handleGetBaselineByKey(deps: BaselineKeyDeps): Promise<Response> {
  return forKey(deps, "get_baseline", async ({ projectId }) => {
    const baseline = await deps.baselines().baselines.get(projectId);
    return reply(200, { baseline: baseline && baselineView(projectId, baseline, deps) });
  });
}

export function handleCompareByKey(experimentId: string, deps: BaselineKeyDeps): Promise<Response> {
  return forKey(deps, "compare", (subject) => comparison(subject, experimentId, deps));
}

export function handlePinByMember(
  request: Request,
  projectId: string,
  deps: BaselineConsoleDeps,
): Promise<Response> {
  return forMember(
    projectId,
    { feature: "evals", operation: "pin_baseline" },
    deps,
    (member) => pin(request, member, actor(member), deps),
    { write: true },
  );
}

export function handleUnpinByMember(
  projectId: string,
  deps: BaselineConsoleDeps,
): Promise<Response> {
  return forMember(
    projectId,
    { feature: "evals", operation: "unpin_baseline" },
    deps,
    (member) => unpin(member, actor(member), deps),
    { write: true },
  );
}

export function handleCompareByMember(
  projectId: string,
  experimentId: string,
  deps: BaselineConsoleDeps,
): Promise<Response> {
  return forMember(projectId, { feature: "evals", operation: "compare" }, deps, (member) =>
    comparison(member, experimentId, deps),
  );
}

async function pin(
  request: Request,
  subject: UsageSubject,
  by: Actor,
  deps: BaselineApiDeps,
): Promise<Response> {
  const body = pinSchema.safeParse(await readJson(request));
  if (!body.success) return refuse(400, "invalid", "experimentId: the id of an experiment.");
  const { projectId } = subject;
  const result = await pinBaseline(
    projectId,
    body.data.experimentId,
    by.pinnedBy,
    deps.baselines(),
  );
  if (!result.ok) {
    return refuse(result.reason === "not_found" ? 404 : 409, result.reason, result.message);
  }
  await deps.track("eval_baseline_pinned", subject, by);
  return reply(200, { baseline: baselineView(projectId, result.baseline, deps) });
}

async function unpin(subject: UsageSubject, by: Actor, deps: BaselineApiDeps): Promise<Response> {
  if (await deps.baselines().baselines.unpin(subject.projectId)) {
    await deps.track("eval_baseline_unpinned", subject, by);
  }
  return reply(200, { baseline: null });
}

async function comparison(
  { projectId }: UsageSubject,
  experimentId: string,
  deps: BaselineApiDeps,
): Promise<Response> {
  const result = await compareWithBaseline(projectId, experimentId, deps.baselines());
  if (result.ok) return reply(200, comparisonView(projectId, result, deps));
  const { reason, message, scorers } = result.refusal;
  if (reason === "not_found") return notFound();
  return reply(COMPARE_STATUS[reason], {
    error: reason,
    message,
    ...(scorers.length > 0 ? { scorers } : {}),
  });
}

/** The wire shape (`protocol/evals/v1/comparison.schema.json`). It has no captured text. */
function comparisonView(
  projectId: string,
  { pin: pinned, candidate, comparison: made }: Extract<ComparisonResult, { ok: true }>,
  deps: BaselineApiDeps,
) {
  return {
    v: 1 as const,
    verdict: made.verdict,
    rule: made.rule,
    baseline: baselineView(projectId, pinned, deps),
    candidate: {
      experimentId: candidate.experiment.id,
      url: urlOf(candidate.experiment, deps),
    },
    url: `${urlOf(candidate.experiment, deps)}/compare`,
    changedCases: changedCases(made),
    otherCases: otherCases(made),
  };
}

function baselineView(projectId: string, baseline: Baseline, deps: BaselineApiDeps) {
  const { experimentId, pinnedBy, pinnedAt } = baseline;
  return {
    experimentId,
    url: urlOf({ projectId, id: experimentId }, deps),
    pinnedBy,
    pinnedAt: pinnedAt.toISOString(),
  };
}

function actor({ externalId }: { externalId: string }): Actor {
  return { pinnedBy: externalId, externalId, surface: "console" };
}
