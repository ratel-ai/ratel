// Caller-supplied ranking functions (ADR-0027). Rust cannot call back into
// JavaScript mid-search, so a search with a `retrieveFn` or `rerankerFn` runs
// in phases: the native registry hands out candidates (the whole catalog, or
// stage 1's top hits), the function ranks them here, and the registry
// completes the search — validating the ranking and recording one event.

import type {
  RankCandidate,
  RankCandidateKind,
  RankedId,
  RankFn,
  SearchOrigin,
} from "./catalog.js";
import { mapEmbedderError, RetrieverError } from "./errors.js";
import type { RuntimeEventProjection } from "./telemetry.js";

/** The native phase API both registries expose. @internal */
export interface NativeCustomRanking<H, S extends { candidates: { id: string; text: string }[] }> {
  rankCandidates(): { id: string; text: string }[];
  completeCustomSearch(
    query: string,
    topK: number,
    origin: string,
    ranked: RankedId[],
    tookMs: number,
    context?: RuntimeEventProjection | null,
  ): H[];
  stageOneAsync(
    query: string,
    topK: number,
    depth: number,
    method: string,
    turnId?: string | null,
  ): Promise<S>;
  completeRerank(
    query: string,
    origin: string,
    stageOne: S,
    ranked: RankedId[] | undefined | null,
    fallbackCode: string | undefined | null,
    tookMs: number,
    context?: RuntimeEventProjection | null,
  ): H[];
}

function withKind(
  candidates: { id: string; text: string }[],
  kind: RankCandidateKind,
): RankCandidate[] {
  return candidates.map(({ id, text }) => ({ id, kind, text }));
}

/** Reject a ranking the core cannot read, naming the function that returned it. */
function checkRanked(value: unknown, name: string): RankedId[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must return an array of { id, score }, got ${typeof value}`);
  }
  for (const item of value) {
    if (
      item === null ||
      typeof item !== "object" ||
      typeof (item as RankedId).id !== "string" ||
      typeof (item as RankedId).score !== "number"
    ) {
      throw new TypeError(`${name} must return an array of { id: string, score: number }`);
    }
  }
  return (value as RankedId[]).map(({ id, score }) => ({ id, score }));
}

const elapsedMs = (started: number): number => Math.round(performance.now() - started);

/** Rank the whole catalog with `fn` and complete the search. @internal */
export async function customSearch<H, S extends { candidates: { id: string; text: string }[] }>(
  native: NativeCustomRanking<H, S>,
  kind: RankCandidateKind,
  fn: RankFn,
  query: string,
  topK: number,
  origin: SearchOrigin,
  context: RuntimeEventProjection | undefined,
): Promise<H[]> {
  const candidates = topK > 0 ? withKind(native.rankCandidates(), kind) : [];
  if (candidates.length === 0) {
    return native.completeCustomSearch(query, topK, origin, [], 0, context);
  }
  const started = performance.now();
  const ranked = checkRanked(await fn(query, candidates, topK), "retrieveFn");
  return native.completeCustomSearch(query, topK, origin, ranked, elapsedMs(started), context);
}

/** Run stage 1 natively, rerank its candidates with `fn`, and complete the search. @internal */
export async function customRerank<H, S extends { candidates: { id: string; text: string }[] }>(
  native: NativeCustomRanking<H, S>,
  kind: RankCandidateKind,
  fn: RankFn,
  query: string,
  topK: number,
  origin: SearchOrigin,
  method: string,
  depth: number,
  context: RuntimeEventProjection | undefined,
): Promise<H[]> {
  let stage: S;
  try {
    stage = await native.stageOneAsync(query, topK, depth, method, context?.turnId);
  } catch (error) {
    throw mapEmbedderError(error);
  }
  const candidates = withKind(stage.candidates, kind);
  if (candidates.length === 0) {
    return native.completeRerank(query, origin, stage, [], undefined, 0, context);
  }
  const started = performance.now();
  let ranked: RankedId[];
  try {
    ranked = checkRanked(await fn(query, candidates, topK), "rerankerFn");
  } catch (error) {
    // A transient failure keeps stage 1's order; the trace says why.
    if (error instanceof RetrieverError && error.transient) {
      return native.completeRerank(
        query,
        origin,
        stage,
        undefined,
        error.code,
        elapsedMs(started),
        context,
      );
    }
    throw error;
  }
  return native.completeRerank(
    query,
    origin,
    stage,
    ranked,
    undefined,
    elapsedMs(started),
    context,
  );
}
