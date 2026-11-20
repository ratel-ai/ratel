import { createHash } from "node:crypto";
import type { EmbeddingProviderPort } from "@/lib/contracts/embedding-provider";

/**
 * Two providers behind one port. An OpenAI-compatible embeddings endpoint when one is
 * configured, else a hashing vectorizer.
 *
 * The endpoint has its own variables (ADR-0033), so embeddings and decisions can use different
 * providers: `EMBEDDING_BASE_URL` (any server that speaks `/embeddings`; alone it is a server
 * that asks for no key), `EMBEDDING_API_KEY` (alone it is OpenAI's endpoint) and
 * `EMBEDDING_MODEL`. With neither of the first two, `OPENAI_API_KEY` selects the endpoint as
 * before, with `OPENAI_BASE_URL` and `OPENAI_EMBEDDING_MODEL`. The OpenAI key and base URL are
 * never used with `EMBEDDING_BASE_URL`: a key goes only to the server it was set for.
 *
 * The hashing vectorizer: a bag of words projected onto a fixed number of dimensions
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
  /** Absent for a server that asks for none. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
};

export function createOpenAiEmbeddingProvider(
  options: OpenAiEmbeddingOptions,
): EmbeddingProviderPort {
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
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!response.ok) {
        throw new Error(`embeddings endpoint answered ${response.status}`);
      }
      const body = (await response.json()) as {
        data?: Array<{ index: number; embedding: number[] }>;
      };
      const rows = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
      if (rows.length !== texts.length) {
        throw new Error(
          `embeddings endpoint returned ${rows.length} vectors for ${texts.length} texts`,
        );
      }
      return rows.map((row) => row.embedding);
    },
  };
}

/** A setting's trimmed value; empty or the deployment placeholder is no setting. */
function set(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "REPLACE_ME" ? trimmed : undefined;
}

/** The provider the environment selects: an OpenAI-compatible endpoint when one is configured, else the local hash. */
export function embeddingProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): EmbeddingProviderPort {
  const baseUrl = set(env.EMBEDDING_BASE_URL);
  const ownKey = set(env.EMBEDDING_API_KEY);
  const model = set(env.EMBEDDING_MODEL) ?? env.OPENAI_EMBEDDING_MODEL;
  if (baseUrl || ownKey) {
    return createOpenAiEmbeddingProvider({ apiKey: ownKey, baseUrl, model, fetch: fetchImpl });
  }
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return localEmbeddingProvider;
  return createOpenAiEmbeddingProvider({
    apiKey,
    baseUrl: env.OPENAI_BASE_URL,
    model,
    fetch: fetchImpl,
  });
}

export const ossEmbeddingProvider: EmbeddingProviderPort = embeddingProviderFromEnv();
