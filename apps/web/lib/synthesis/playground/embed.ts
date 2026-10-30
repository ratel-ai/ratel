import { createHash } from "node:crypto";
import type { EmbeddingProviderPort } from "@/lib/contracts/embedding-provider";

/**
 * Embeddings for a test search, through the embedding-provider port. Session-authenticated and
 * uncharged, fenced by the caps below plus a per-user quota. Identical text is served from the
 * process cache, so a repeat run with one edited description is a single short input.
 */

/** Longest single input we will embed. Longer text is truncated, not rejected. */
export const MAX_INPUT_CHARS = 2_000;
/** Most texts one provider request may carry. Larger inputs are chunked. */
export const PROVIDER_BATCH_SIZE = 128;
/** Overall ceiling for one call: a sanity bound, not a realistic catalog size. */
export const MAX_TEXTS = 2_048;
/** Entries kept in the process-wide vector cache. */
const MAX_CACHE_ENTRIES = 4_000;
const PROVIDER_TIMEOUT_MS = 30_000;

export type EmbeddingFailureReason =
  | "not_configured"
  | "upstream_unreachable"
  | "upstream_unreadable"
  | "too_many_inputs";

export type EmbedResult =
  | {
      ok: true;
      vectors: number[][];
      embeddedCount: number;
      cachedCount: number;
      /** True when the local hashing stand-in produced these, not a trained model. */
      local?: boolean;
    }
  | { ok: false; reason: EmbeddingFailureReason; status: number };

type EmbedFailure = Extract<EmbedResult, { ok: false }>;

export interface EmbedDeps {
  provider: EmbeddingProviderPort;
  /** Injected in tests; defaults to the module-level process cache. */
  cache?: Map<string, number[]>;
  timeoutMs?: number;
}

const processCache = new Map<string, number[]>();

/** Whether this deployment can embed at all, so the UI can disable the modes up front. */
export function embeddingsConfigured(provider: EmbeddingProviderPort): boolean {
  return provider.isAvailable();
}

/** Clip to the input cap. The engine ranks on the head of a description anyway. */
export function clipInput(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_INPUT_CHARS ? trimmed : trimmed.slice(0, MAX_INPUT_CHARS);
}

function cacheKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Insertion-ordered eviction: oldest key first once the cache is full. */
function remember(cache: Map<string, number[]>, key: string, vector: number[]) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, vector);
}

/** One provider request. The port has no signal, so a timed-out request finishes unobserved. */
async function embedBatch(
  inputs: readonly string[],
  deps: EmbedDeps,
): Promise<{ ok: true; vectors: number[][] } | EmbedFailure> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("embeddings timed out")),
      deps.timeoutMs ?? PROVIDER_TIMEOUT_MS,
    );
  });
  try {
    const vectors = await Promise.race([deps.provider.embed(inputs), timeout]);
    return vectors.length === inputs.length
      ? { ok: true, vectors }
      : { ok: false, reason: "upstream_unreadable", status: 502 };
  } catch {
    return { ok: false, reason: "upstream_unreachable", status: 502 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed `texts` in input order. Cache hits never reach the provider, so the returned
 * `embeddedCount` is what a run actually cost upstream.
 */
export async function embedTexts(texts: readonly string[], deps: EmbedDeps): Promise<EmbedResult> {
  if (texts.length > MAX_TEXTS) {
    return { ok: false, reason: "too_many_inputs", status: 400 };
  }
  if (!deps.provider.isAvailable()) {
    return { ok: false, reason: "not_configured", status: 503 };
  }

  const clipped = texts.map(clipInput);
  if (deps.provider.local) {
    const batch = await embedBatch(clipped, deps);
    if (!batch.ok) return batch;
    return {
      ok: true,
      vectors: batch.vectors,
      embeddedCount: 0,
      cachedCount: texts.length,
      local: true,
    };
  }

  const cache = deps.cache ?? processCache;
  const keys = clipped.map(cacheKey);
  // One slot per distinct uncached text: repeated descriptions must not pay for each copy.
  const pending = new Map<string, string>();
  keys.forEach((key, index) => {
    if (!cache.has(key) && !pending.has(key)) pending.set(key, clipped[index]);
  });

  // Chunks run in order so a partial failure leaves the cache consistent with what succeeded.
  const pendingKeys = [...pending.keys()];
  for (let start = 0; start < pendingKeys.length; start += PROVIDER_BATCH_SIZE) {
    const chunkKeys = pendingKeys.slice(start, start + PROVIDER_BATCH_SIZE);
    const inputs = chunkKeys.map((key) => pending.get(key) as string);
    const batch = await embedBatch(inputs, deps);
    if (!batch.ok) return batch;
    chunkKeys.forEach((key, index) => {
      remember(cache, key, batch.vectors[index]);
    });
  }

  return {
    ok: true,
    vectors: keys.map((key) => cache.get(key) ?? []),
    embeddedCount: pending.size,
    cachedCount: keys.length - pending.size,
  };
}
