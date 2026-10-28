import { createHash } from "node:crypto";
import type { EmbeddingProviderPort } from "@/lib/contracts/embedding-provider";

/**
 * Two providers behind one port. With `OPENAI_API_KEY` set, an OpenAI-compatible embeddings
 * endpoint (`OPENAI_BASE_URL` for a private gateway, `OPENAI_EMBEDDING_MODEL` to pick the model).
 * Without it, a hashing vectorizer: a bag of words projected onto a fixed number of dimensions
 * and L2-normalized, so cosine similarity over it means something real and stable (shared
 * vocabulary), just something much cruder than a trained embedding. It is labelled `local` so
 * every run made with it says so in the UI. Nothing here ever calls out without a key.
 */
export const LOCAL_EMBEDDING_DIMENSIONS = 256;
export const LOCAL_EMBEDDING_MODEL = "local-hash-256";
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

/** Lowercase word-ish runs. Matches nothing clever on purpose. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

/** A stable bucket per token, from the first four bytes of its digest. */
function bucket(token: string): number {
  const digest = createHash("sha1").update(token).digest();
  return digest.readUInt32BE(0) % LOCAL_EMBEDDING_DIMENSIONS;
}

/** One deterministic vector per text; the zero vector for an input with no tokens. */
export function localEmbedding(text: string): number[] {
  const vector = new Array<number>(LOCAL_EMBEDDING_DIMENSIONS).fill(0);
  for (const token of tokenize(text)) vector[bucket(token)] += 1;
  for (let i = 0; i < vector.length; i++) {
    if (vector[i] > 0) vector[i] = 1 + Math.log(vector[i]);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

export const localEmbeddingProvider: EmbeddingProviderPort = {
  model: LOCAL_EMBEDDING_MODEL,
  local: true,
  isAvailable: () => true,
  async embed(texts) {
    return texts.map(localEmbedding);
  },
};

export type OpenAiEmbeddingOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
};

export function createOpenAiEmbeddingProvider(options: OpenAiEmbeddingOptions): EmbeddingProviderPort {
  const model = options.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL;
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  return {
    model,
    local: false,
    isAvailable: () => true,
    async embed(texts) {
      if (texts.length === 0) return [];
      const response = await doFetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!response.ok) {
        throw new Error(`embeddings endpoint answered ${response.status}`);
      }
      const body = (await response.json()) as { data?: Array<{ index: number; embedding: number[] }> };
      const rows = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
      if (rows.length !== texts.length) {
        throw new Error(`embeddings endpoint returned ${rows.length} vectors for ${texts.length} texts`);
      }
      return rows.map((row) => row.embedding);
    },
  };
}

/** The provider the environment selects: OpenAI-compatible when keyed, else the local hash. */
export function embeddingProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProviderPort {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return localEmbeddingProvider;
  return createOpenAiEmbeddingProvider({
    apiKey,
    baseUrl: env.OPENAI_BASE_URL,
    model: env.OPENAI_EMBEDDING_MODEL,
  });
}

export const ossEmbeddingProvider: EmbeddingProviderPort = embeddingProviderFromEnv();
