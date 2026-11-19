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
  /**
   * Rejects when the provider cannot answer. An error carrying a `reason` (see
   * {@link EmbeddingProviderFailure}) says the provider answered but was refused or unreadable;
   * any other error counts as unreachable.
   */
  embed(texts: readonly string[]): Promise<number[][]>;
  /**
   * Called when a run wanted vectors while `isAvailable()` is false, so the edition can record
   * the call it skipped (a `skipped_no_key` model-call line). Absent in the open-source edition,
   * which records nothing.
   */
  noteUnavailable?(): void;
};

/**
 * Why `embed` failed, set as `reason` on the error it throws: the provider answered with an
 * error status (`upstream_rejected`) or with something that holds no vectors
 * (`upstream_unreadable`).
 */
export type EmbeddingProviderFailure = "upstream_rejected" | "upstream_unreadable";
