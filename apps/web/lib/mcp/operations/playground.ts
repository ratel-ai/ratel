import { z } from "zod";
import { composition } from "@/lib/composition/ports";
import { authDistinctId } from "@/lib/mcp/auth";
import { McpOperationError } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { round, truncateText } from "@/lib/mcp/serialize";
import { loadBench } from "@/lib/synthesis/playground/catalog";
import { MAX_QUERY_CHARS } from "@/lib/synthesis/playground/contract";
import { embedTexts } from "@/lib/synthesis/playground/embed";
import { createFixedWindowQuota, type FixedWindowQuota } from "@/lib/synthesis/playground/quota";
import type { EmbeddingVectors } from "@/lib/synthesis/playground/rank";
import { runPlayground } from "@/lib/synthesis/playground/run";
import type { DraftsByKind, RankedBuckets, RankedHit } from "@/lib/synthesis/playground/types";
import { assembleVectors, planVectorBatches } from "@/lib/synthesis/playground/vectors";

/**
 * Rank a query against the live catalog, once as stored and once with proposed
 * edits applied.
 *
 * This is the operation that turns the rest of the surface from reporting into
 * work. An agent can already read that a skill is searched for and never
 * retrieved (`get_improvement_signals`) and which real queries disagreed with
 * the shadow arm (`list_calibration_mismatches`), but until now the only way to
 * find out whether a rewritten description would actually fix either was to
 * write it to the catalog and wait for production traffic. Here the edit is a
 * *draft*: nothing is written, the same engine ranks both readings, and the
 * diff says whether the change did what was intended. Then, and only then,
 * `update_skill` or `set_catalog_override` makes it real.
 *
 * ## Rate limiting
 *
 * `POST /api/playground/rank` already meters this, and it meters exactly one
 * thing: embedding-backed runs, 120 per user per hour, because those spend the
 * server's own provider credential. BM25 runs are unmetered there, which is
 * correct for that surface. A human clicking a button is self-limiting, and a
 * session cookie is a person.
 *
 * Neither assumption survives contact with an agent. A loop iterating on a
 * description can run this as fast as the network allows, and every run, BM25
 * included, re-reads the whole bench: skills, observed tools, synced tools,
 * definitions and runtime entries, five queries against tables sized by the
 * customer's traffic. So this surface meters both: a wide budget on runs in
 * general, guarding the database, and a much tighter one on the embedding modes,
 * guarding the provider credential. Both are keyed per credential rather than
 * per user, so one project's runaway loop cannot spend another's budget.
 *
 * Like every limiter in this codebase these are per process, so the real
 * ceiling is this number times the running task count. They are a blast-radius
 * cap, not an accounting boundary.
 */
const RUNS_PER_HOUR = 240;
const EMBEDDING_RUNS_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Drafts an agent sends, capped far below the browser client's 200.
 *
 * The Playground UI holds a whole editing session's worth of unsaved edits and
 * replays them on every run. An agent testing whether one description fixes one
 * query sends one draft, or a handful. The high cap exists for a workflow this
 * surface does not have, and paying for it here means a 256 KB request body of
 * descriptions before anything is even ranked.
 */
const MAX_DRAFTS_PER_KIND = 25;
const MATCH_TEXT_PREVIEW_CHARS = 300;

const draft = z.object({
  description: z
    .string()
    .max(4 * 1024)
    .optional()
    .describe("Replacement retrieval text to test. Not saved."),
  tags: z.array(z.string().min(1).max(128)).max(64).optional(),
});

const draftMap = z
  .record(z.string().min(1).max(256), draft)
  .refine(
    (value) => Object.keys(value).length <= MAX_DRAFTS_PER_KIND,
    `at most ${MAX_DRAFTS_PER_KIND} drafts per kind`,
  );

export interface PlaygroundOperationDeps {
  loadBench: typeof loadBench;
  embedTexts: typeof embedTexts;
  runPlayground: typeof runPlayground;
  runQuota: FixedWindowQuota;
  embeddingQuota: FixedWindowQuota;
  now: () => number;
}

export const defaultPlaygroundDeps: PlaygroundOperationDeps = {
  loadBench,
  embedTexts,
  runPlayground,
  runQuota: createFixedWindowQuota(RUNS_PER_HOUR, HOUR_MS),
  embeddingQuota: createFixedWindowQuota(EMBEDDING_RUNS_PER_HOUR, HOUR_MS),
  now: Date.now,
};

function rateLimited(resetAt: number, now: number, what: string): McpOperationError {
  return new McpOperationError("rate_limited", `Too many ${what}. Try again shortly.`, {
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
  });
}

/**
 * One ranked hit, stripped to what a ranking question actually needs.
 *
 * `RankedHit` carries the full agent-facing description and the full text the
 * hit was matched on, each up to 4 KB. At twenty-five hits across two runs that
 * is megabytes of prose to answer "did my edit move this up", and most of it is
 * text the caller already has. Only an edited hit keeps a preview of its match
 * text, because that is the one place the caller cannot otherwise confirm that
 * the draft it sent is the text that was scored.
 */
function summarizeHit(hit: RankedHit) {
  return {
    id: hit.id,
    rank: hit.rank,
    score: round(hit.score),
    ...(hit.bm25Score !== null ? { bm25Score: round(hit.bm25Score) } : {}),
    ...(hit.embeddingScore !== null ? { embeddingScore: round(hit.embeddingScore) } : {}),
    matchedOn: hit.searchableDescriptionSource,
    ...(hit.edited
      ? {
          edited: true,
          matchedText: truncateText(hit.searchableDescription, MATCH_TEXT_PREVIEW_CHARS).text,
        }
      : {}),
  };
}

function summarizeBuckets(buckets: RankedBuckets) {
  return {
    skills: buckets.skills.map(summarizeHit),
    tools: buckets.tools.map(summarizeHit),
  };
}

export function playgroundOperations(
  deps: PlaygroundOperationDeps = defaultPlaygroundDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "test_retrieval",
      domain: "joins",
      title: "Test retrieval against the live catalog",
      description:
        "Rank a query against this project's real catalog, once as stored and once with proposed description edits applied, and return the difference. Nothing is written: this is how to check a rewrite fixes a query before saving it with update_skill or set_catalog_override. Mode bm25 is free; embeddings and hybrid call the embedding provider, cost money, and are metered tighter.",
      keywords: [
        "test a change",
        "what if",
        "playground",
        "try",
        "simulate",
        "rank",
        "before saving",
        "bm25",
        "hybrid",
      ],
      scope: "project",
      // Truthfully read-only: no skill, tool or override is touched. The cost of
      // the embedding modes is carried in the description and the quotas, not by
      // mislabelling this as a write.
      mutates: false,
      params: z.object({
        ...projectScoped,
        query: z
          .string()
          .trim()
          .min(1)
          .max(MAX_QUERY_CHARS)
          .describe("The prompt to rank, ideally a real one from calibration or search history."),
        mode: z
          .enum(["bm25", "embeddings", "hybrid"])
          .default("bm25")
          .describe("bm25 is free; embeddings and hybrid spend the embedding provider budget."),
        topKSkills: z.number().int().min(1).max(25).default(5),
        topKTools: z.number().int().min(1).max(25).default(5),
        embeddingWeight: z
          .number()
          .min(0)
          .max(1)
          .default(0.5)
          .describe("How much the embedding score counts in hybrid mode."),
        drafts: z
          // Each kind defaults to empty independently. The browser client always
          // sends both maps because it holds both editors open; an agent editing
          // one skill sends `{ skill: {...} }` and nothing else, and requiring
          // an empty `tool: {}` alongside it would fail a request that is
          // perfectly well formed.
          .object({ skill: draftMap.default({}), tool: draftMap.default({}) })
          .default({ skill: {}, tool: {} })
          .describe(
            "Unsaved edits to test, keyed by skill name or tool name. Send only the kind you are editing. Omit entirely to rank the catalog as it stands.",
          ),
        includeSyncedTools: z
          .boolean()
          .default(true)
          .describe("Include runtime-synced tool definitions in the bench."),
      }),
      async execute(ctx, params) {
        // Keyed per credential, not per user: an API key is the thing whose loop
        // runs away, and two keys in one organization should not share a budget.
        const budgetKey = authDistinctId(ctx.auth);
        const now = deps.now();

        const runBudget = deps.runQuota.consume(budgetKey);
        if (!runBudget.allowed) {
          throw rateLimited(runBudget.resetAt, now, "playground runs");
        }

        const wantsVectors = params.mode !== "bm25";
        let embeddingBudgetRemaining: number | null = null;
        if (wantsVectors) {
          // Charged before the work, and only for the modes that spend the
          // provider credential. A BM25 run has already paid the run budget
          // above, which is what the database read costs us.
          const decision = deps.embeddingQuota.consume(budgetKey);
          if (!decision.allowed) {
            throw rateLimited(
              decision.resetAt,
              now,
              "embedding-backed runs. Use mode bm25 in the meantime, which is not metered against this budget",
            );
          }
          embeddingBudgetRemaining = decision.remaining;
        }

        const bench = await deps.loadBench(ctx.projectId, {
          includeSyncedTools: params.includeSyncedTools,
        });
        const drafts = params.drafts as DraftsByKind;

        let vectors: { baseline?: EmbeddingVectors; drafted?: EmbeddingVectors } = {};
        let embedded = { embeddedCount: 0, cachedCount: 0, local: false };
        if (wantsVectors) {
          const built = await buildVectors(deps, params.query, bench, drafts);
          vectors = built.vectors;
          embedded = built.usage;
        }

        const run = deps.runPlayground({
          query: params.query,
          skills: bench.skills,
          tools: bench.tools,
          drafts,
          options: {
            mode: params.mode,
            topKSkills: params.topKSkills,
            topKTools: params.topKTools,
            embeddingWeight: params.embeddingWeight,
          },
          baselineVectors: vectors.baseline,
          draftedVectors: vectors.drafted,
        });

        return {
          data: {
            query: params.query,
            mode: params.mode,
            benchSize: { skills: bench.skills.length, tools: bench.tools.length },
            baseline: summarizeBuckets(run.baseline),
            // Identical to baseline when nothing was drafted, so returning it
            // twice would just cost tokens to say "unchanged".
            ...(run.hasEdits
              ? {
                  drafted: summarizeBuckets(run.drafted),
                  diff: {
                    skills: run.diff.skills.summary,
                    tools: run.diff.tools.summary,
                  },
                  changes: run.changes,
                }
              : {}),
            ...(wantsVectors
              ? {
                  embedding: {
                    embeddedCount: embedded.embeddedCount,
                    cachedCount: embedded.cachedCount,
                    runsRemainingThisHour: embeddingBudgetRemaining,
                    // A hashing stand-in produces real scores that are much
                    // cruder than a trained model's. A run that did not say so
                    // would be mistaken for the genuine article and tuned against.
                    local: embedded.local,
                  },
                }
              : {}),
          },
          hint: run.hasEdits
            ? "Nothing was saved. If the drafted ranking is the one you want, apply it with update_skill (skills) or set_catalog_override (runtime tools)."
            : "This is the catalog as it stands. Pass drafts to test a description change against the same query.",
        };
      },
    }),
  ];
}

/**
 * Embed the query and both readings of every capability.
 *
 * Baseline and drafted text go in one batch: an edited description is the only
 * text that differs between the two runs and the process cache dedupes the
 * rest, so the drafted pass is close to free. This mirrors the route's own
 * `buildVectors`; the difference is the failure mapping, since an MCP caller
 * needs a machine code rather than an HTTP status.
 */
async function buildVectors(
  deps: PlaygroundOperationDeps,
  query: string,
  bench: Awaited<ReturnType<typeof loadBench>>,
  drafts: DraftsByKind,
) {
  const batches = planVectorBatches(query, bench, drafts);
  const embedDeps = { provider: composition.embeddingProvider };
  const [skillVectors, toolVectors] = await Promise.all([
    deps.embedTexts(batches.skillTexts, embedDeps),
    deps.embedTexts(batches.toolTexts, embedDeps),
  ]);

  for (const result of [skillVectors, toolVectors]) {
    if (result.ok) continue;
    // Not configured is an environment fact, not the caller's mistake, and a
    // catalog too large to embed will not become embeddable by retrying.
    if (result.reason === "not_configured") {
      throw new McpOperationError(
        "unavailable",
        "Embeddings are not configured for this deployment. Use mode bm25.",
        { reason: result.reason },
      );
    }
    if (result.reason === "too_many_inputs") {
      throw new McpOperationError(
        "invalid_params",
        "This catalog is too large to embed in one run. Use mode bm25.",
        { reason: result.reason },
      );
    }
    throw new McpOperationError(
      "unavailable",
      "The embedding provider is unavailable. Try again shortly, or use mode bm25.",
      { reason: result.reason },
    );
  }
  if (!skillVectors.ok || !toolVectors.ok) {
    // Unreachable: narrowed by the loop above. Keeps the compiler honest.
    throw new McpOperationError("internal", "Embedding failed.");
  }

  return {
    vectors: assembleVectors(bench, drafts, skillVectors.vectors, toolVectors.vectors),
    usage: {
      embeddedCount: skillVectors.embeddedCount + toolVectors.embeddedCount,
      cachedCount: skillVectors.cachedCount + toolVectors.cachedCount,
      local: skillVectors.local === true || toolVectors.local === true,
    },
  };
}
