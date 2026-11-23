import { z } from "zod";
import type { PlaygroundRun } from "./run";

/**
 * The wire contract for `POST /api/playground/rank`, shared by the route and the
 * client so both validate against one schema.
 *
 * The baseline catalog is NOT part of the request. The client sends only the
 * query, the run options, and its drafts; the server reads the skills and
 * observed tools itself. A client-supplied baseline would let a caller rank
 * against a catalog they do not own, and would also make "what does this look
 * like today" answerable with whatever the caller felt like claiming.
 */

export const MAX_QUERY_CHARS = 1_000;
/**
 * Per-bucket cap on the capabilities one bench holds.
 *
 * Lives here rather than beside `loadBench` because the UI reports it, and the
 * bench is a client component: importing it from the loader dragged the whole
 * database module into the browser bundle.
 *
 * Sized for a real catalog (hundreds of tools is normal) and enforced as a
 * backstop against an unbounded read, not as a page size. The list is not
 * paginated: it is ordered, banded and searched, and rows mount in increments.
 */
export const MAX_BENCH_CAPABILITIES = 500;
export const MAX_DRAFTS_PER_KIND = 200;
/** Matches the catalog's own description cap in `lib/catalog/manage.ts`. */
const MAX_DRAFT_DESCRIPTION = 4 * 1024;
const MAX_TOP_K = 25;

const draft = z.object({
  description: z.string().max(MAX_DRAFT_DESCRIPTION).optional(),
  tags: z.array(z.string().min(1).max(128)).max(64).optional(),
});

const draftMap = z
  .record(z.string().min(1).max(256), draft)
  .refine(
    (value) => Object.keys(value).length <= MAX_DRAFTS_PER_KIND,
    `at most ${MAX_DRAFTS_PER_KIND} drafts`,
  );

export const rankRequest = z.object({
  projectId: z.string().min(1),
  query: z.string().trim().min(1).max(MAX_QUERY_CHARS),
  mode: z.enum(["bm25", "embeddings", "hybrid"]).default("bm25"),
  topKSkills: z.number().int().min(1).max(MAX_TOP_K).default(5),
  topKTools: z.number().int().min(1).max(MAX_TOP_K).default(5),
  embeddingWeight: z.number().min(0).max(1).default(0.5),
  drafts: z.object({ skill: draftMap, tool: draftMap }).default({ skill: {}, tool: {} }),
});

export type RankRequest = z.infer<typeof rankRequest>;

/** What one embedding-backed run actually cost upstream. */
export interface EmbeddingUsageReport {
  /** Texts sent to the provider. Cache hits are not counted. */
  embeddedCount: number;
  cachedCount: number;
  /** Runs left in this user's current quota window. */
  remaining: number;
  /**
   * True when a development stand-in produced the vectors instead of the
   * provider. Carried all the way to the UI on purpose: scores from a hashing
   * vectorizer are real but much cruder than a trained model's, and a run that
   * did not say so would be mistaken for the genuine article.
   */
  local: boolean;
}

export interface RankResponse {
  run: PlaygroundRun;
  /** Null on a BM25 run, where nothing was embedded. */
  embedding: EmbeddingUsageReport | null;
}
