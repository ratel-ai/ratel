import type { EmbeddingProviderPort } from "@/lib/contracts/embedding-provider";
import type { Bench } from "./catalog";
import { type RankResponse, rankRequest } from "./contract";
import { embedTexts } from "./embed";
import type { FixedWindowQuota } from "./quota";
import type { EmbeddingVectors } from "./rank";
import { runPlayground } from "./run";
import type { DraftsByKind } from "./types";
import { assembleVectors, planVectorBatches } from "./vectors";

/**
 * `POST /api/playground/rank`: rank a prompt against a project's live catalog with the SDK's own
 * engine, once as stored and once with the caller's what-if edits. Writes nothing to the catalog.
 */

export interface RankRouteDeps {
  getSession: () => Promise<{ userId: string; externalId: string } | null>;
  findProject: (projectId: string) => Promise<{ projectId: string; organizationId: string } | null>;
  loadBench: (projectId: string) => Promise<Bench>;
  provider: EmbeddingProviderPort;
  quota: FixedWindowQuota;
  /** Injected in tests; defaults to the embedder's process cache. */
  embedCache?: Map<string, number[]>;
  setLogContext: (context: { project_id: string; org_id: string; distinct_id: string }) => void;
  logError: (fields: Record<string, unknown>, message: string) => void;
  trackRun: (
    properties: { mode: string; edited_capabilities: number; embedded_inputs: number },
    context: { externalId: string; projectId: string; orgId: string },
  ) => Promise<void>;
}

export async function rankResponse(body: unknown, deps: RankRouteDeps): Promise<Response> {
  const session = await deps.getSession();
  if (!session) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const parsed = rankRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid run.", issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;

  const project = await deps.findProject(input.projectId);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  deps.setLogContext({
    project_id: project.projectId,
    org_id: project.organizationId,
    distinct_id: session.externalId,
  });

  // Read the same way the page reads it, so the bench on screen is the catalog this run scores.
  const bench = await deps.loadBench(project.projectId);
  const drafts: DraftsByKind = input.drafts;

  let vectors: { baseline?: EmbeddingVectors; drafted?: EmbeddingVectors } = {};
  let embedding: RankResponse["embedding"] = null;
  if (input.mode !== "bm25") {
    const decision = deps.quota.consume(session.externalId);
    if (!decision.allowed) {
      return Response.json(
        {
          error: "Embedding runs are rate limited. Try again shortly.",
          resetAt: new Date(decision.resetAt).toISOString(),
        },
        { status: 429 },
      );
    }

    const built = await buildVectors(input.query, bench, drafts, deps);
    if (!built.ok) {
      deps.logError(
        { reason: built.reason, project_id: project.projectId },
        "test a search embedding failed",
      );
      return Response.json({ error: built.message }, { status: built.status });
    }
    vectors = built.vectors;
    embedding = {
      embeddedCount: built.embeddedCount,
      cachedCount: built.cachedCount,
      remaining: decision.remaining,
      local: built.local,
    };
  }

  const run = runPlayground({
    query: input.query,
    skills: bench.skills,
    tools: bench.tools,
    drafts,
    options: {
      mode: input.mode,
      topKSkills: input.topKSkills,
      topKTools: input.topKTools,
      embeddingWeight: input.embeddingWeight,
    },
    baselineVectors: vectors.baseline,
    draftedVectors: vectors.drafted,
  });

  await deps.trackRun(
    {
      mode: input.mode,
      edited_capabilities: run.changes.length,
      embedded_inputs: embedding?.embeddedCount ?? 0,
    },
    {
      externalId: session.externalId,
      projectId: project.projectId,
      orgId: project.organizationId,
    },
  );

  const response: RankResponse = { run, embedding };
  return Response.json(response);
}

type VectorBuild =
  | {
      ok: true;
      vectors: { baseline: EmbeddingVectors; drafted: EmbeddingVectors };
      embeddedCount: number;
      cachedCount: number;
      local: boolean;
    }
  | { ok: false; reason: string; message: string; status: number };

const EMBED_FAILURE_MESSAGE: Record<string, string> = {
  not_configured: "Embeddings are not configured for this environment.",
  too_many_inputs: "This catalog is too large to embed in one run.",
};

/** Baseline and drafted text go in one batch: only an edited description differs between them. */
async function buildVectors(
  query: string,
  bench: Bench,
  drafts: DraftsByKind,
  deps: RankRouteDeps,
): Promise<VectorBuild> {
  const batches = planVectorBatches(query, bench, drafts);
  const embedDeps = { provider: deps.provider, cache: deps.embedCache };
  const [skills, tools] = await Promise.all([
    embedTexts(batches.skillTexts, embedDeps),
    embedTexts(batches.toolTexts, embedDeps),
  ]);

  if (!skills.ok || !tools.ok) {
    const failure = !skills.ok ? skills : (tools as Extract<typeof tools, { ok: false }>);
    return {
      ok: false,
      reason: failure.reason,
      message:
        EMBED_FAILURE_MESSAGE[failure.reason] ??
        "The embedding provider is unavailable. Try again shortly.",
      status: failure.status,
    };
  }

  return {
    ok: true,
    vectors: assembleVectors(bench, drafts, skills.vectors, tools.vectors),
    embeddedCount: skills.embeddedCount + tools.embeddedCount,
    cachedCount: skills.cachedCount + tools.cachedCount,
    local: skills.local === true || tools.local === true,
  };
}
