import { createHash } from "node:crypto";
import { type Config, getConfig } from "@/config";
import type { EmbeddingProviderPort } from "@/lib/contracts/embedding-provider";

/**
 * Two providers behind one port. An OpenAI-compatible embeddings endpoint when one is
 * configured, else a hashing vectorizer.
 *
 * The endpoint has its own settings (ADR-0009), so embeddings and decisions can use different
 * providers: `embeddings.baseUrl` (any server that speaks `/embeddings`; alone it is a server
 * that asks for no key), `embeddings.apiKey` (alone it is OpenAI's endpoint) and
 * `embeddings.model`. With neither of the first two, `openai.apiKey` (OPENAI_API_KEY) selects the
 * endpoint as before, with `openai.baseUrl` and `openai.embeddingModel`. The OpenAI key and base
 * URL are never used with `embeddings.baseUrl`: a key goes only to the server it was set for.
 *
 * The hashing vectorizer: a bag of words projected onto a fixed number of dimensions
 * and L2-normalized, so cosine similarity over it means something real and stable (shared
 * vocabulary), just something much cruder than a trained embedding. It is labelled `local` so
 * every run made with it says so in the UI. Nothing here ever calls out without a key.
 */
export const LOCAL_EMBEDDING_DIMENSIONS = 256;
export const LOCAL_EMBEDDING_MODEL = "local-hash-256";
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

/** OpenAI's embeddings, when no other address is set. */
export const OPENAI_EMBEDDINGS_BASE_URL = "https://api.openai.com/v1";

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
  const baseUrl = (options.baseUrl ?? OPENAI_EMBEDDINGS_BASE_URL).replace(/\/+$/, "");
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
        // A redirect would carry the texts, and the key, to another address.
        redirect: "error",
      });
      if (!response.ok) {
        // The status alone: the console's model status reads it (ADR-0009 §13).
        throw Object.assign(new Error(`embeddings endpoint answered ${response.status}`), {
          status: response.status,
        });
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

/** The provider the settings select: an OpenAI-compatible endpoint when one is configured, else the local hash. */
export function embeddingProviderFromConfig(
  config: Pick<Config, "openai" | "embeddings"> = getConfig(),
  fetchImpl?: typeof fetch,
): EmbeddingProviderPort {
  const { embeddings, openai } = config;
  const model = embeddings.model ?? openai.embeddingModel;
  if (embeddings.baseUrl || embeddings.apiKey) {
    const { apiKey, baseUrl } = embeddings;
    return createOpenAiEmbeddingProvider({ apiKey, baseUrl, model, fetch: fetchImpl });
  }
  const { apiKey, baseUrl } = openai;
  if (!apiKey) return localEmbeddingProvider;
  return createOpenAiEmbeddingProvider({ apiKey, baseUrl, model, fetch: fetchImpl });
}

export const ossEmbeddingProvider: EmbeddingProviderPort = embeddingProviderFromConfig();
