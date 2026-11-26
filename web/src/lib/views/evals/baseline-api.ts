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

export function handleUnpinByKey(request: Request, deps: BaselineKeyDeps): Promise<Response> {
  return forKey(deps, "unpin_baseline", (subject, apiKeyId) =>
    unpin(request, subject, { pinnedBy: `key:${apiKeyId}`, surface: "api" }, deps),
  );
}

export function handleGetBaselineByKey(deps: BaselineKeyDeps): Promise<Response> {
  return forKey(deps, "get_baseline", async ({ projectId }) => {
    const baseline = await deps.baselines().baselines.get(projectId);
    return reply(200, { baseline: baseline && baselineView(projectId, baseline, deps) });
  });
}

/** `baselineId`: the experiment to compare with. Null: the pinned baseline. */
export function handleCompareByKey(
  experimentId: string,
  deps: BaselineKeyDeps,
  baselineId: string | null = null,
): Promise<Response> {
  return forKey(deps, "compare", (subject) => comparison(subject, experimentId, baselineId, deps));
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
  request: Request,
  projectId: string,
  deps: BaselineConsoleDeps,
): Promise<Response> {
  return forMember(
    projectId,
    { feature: "evals", operation: "unpin_baseline" },
    deps,
    (member) => unpin(request, member, actor(member), deps),
    { write: true },
  );
}

export function handleCompareByMember(
  projectId: string,
  experimentId: string,
  deps: BaselineConsoleDeps,
  baselineId: string | null = null,
): Promise<Response> {
  return forMember(projectId, { feature: "evals", operation: "compare" }, deps, (member) =>
    comparison(member, experimentId, baselineId, deps),
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

/** With `?experimentId=`, removes the pin only when it is still that experiment. */
async function unpin(
  request: Request,
  subject: UsageSubject,
  by: Actor,
  deps: BaselineApiDeps,
): Promise<Response> {
  const shown = new URL(request.url).searchParams.get("experimentId") ?? undefined;
  if (shown !== undefined && !z.uuid().safeParse(shown).success) {
    return refuse(400, "invalid", "experimentId: the id of an experiment.");
  }
  const { baselines } = deps.baselines();
  if (await baselines.unpin(subject.projectId, shown)) {
    await deps.track("eval_baseline_unpinned", subject, by);
  } else if (shown !== undefined && (await baselines.get(subject.projectId))) {
    return refuse(409, "changed", "Another experiment is the baseline now. Load the page again.");
  }
  return reply(200, { baseline: null });
}

async function comparison(
  { projectId }: UsageSubject,
  experimentId: string,
  baselineId: string | null,
  deps: BaselineApiDeps,
): Promise<Response> {
  const result = await compareWithBaseline(projectId, experimentId, deps.baselines(), baselineId);
  if (result.ok) return reply(200, comparisonView(projectId, result, baselineId, deps));
  const { reason, message, scorers, pin: pinned, otherId } = result.refusal;
  if (reason === "not_found") return notFound();
  const other = otherId && { experimentId: otherId, url: urlOf({ projectId, id: otherId }, deps) };
  return reply(COMPARE_STATUS[reason], {
    error: reason,
    message,
    ...(scorers.length > 0 ? { scorers } : {}),
    ...(pinned
      ? { baseline: baselineView(projectId, pinned, deps) }
      : other
        ? { baseline: other }
        : {}),
  });
}

/** The wire shape (`protocol/evals/v1/comparison.schema.json`). It has no captured text. */
function comparisonView(
  projectId: string,
  { pin: pinned, baseline, candidate, comparison: made }: Extract<ComparisonResult, { ok: true }>,
  baselineId: string | null,
  deps: BaselineApiDeps,
) {
  const page = `${urlOf(candidate.experiment, deps)}/compare`;
  return {
    v: 1 as const,
    verdict: made.verdict,
    rule: made.rule,
    // A chosen experiment that is not pinned has no pin to show.
    baseline: pinned
      ? baselineView(projectId, pinned, deps)
      : { experimentId: baseline.experiment.id, url: urlOf(baseline.experiment, deps) },
    candidate: {
      experimentId: candidate.experiment.id,
      url: urlOf(candidate.experiment, deps),
    },
    url: baselineId ? `${page}?baseline=${baseline.experiment.id}` : page,
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
