/**
 * Dense vectors for the Playground's embedding and hybrid modes. The open-source edition uses
 * an OpenAI-compatible endpoint when a key is configured and a local hashing vectorizer
 * otherwise; the Cloud edition fronts its hosted model. `local` is true when the vectors are
 * the hashing stand-in, so every run made with them is labelled as such in the UI.
 */
export type EmbeddingProviderPort = {
  readonly model: string;
  readonly local: boolean;
  isAvailable(): boolean;
  embed(texts: readonly string[]): Promise<number[][]>;
};
