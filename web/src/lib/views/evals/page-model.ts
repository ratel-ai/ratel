import type { Trial } from "./domain/experiment";

/** What the pages of evals show. Plain data. */

/** The longest text of a cell of a table. The page of the item shows the full value. */
export const PREVIEW_CHARS = 160;

/** A trial as the trial panel shows it. */
export type TrialView = Omit<Trial, "experimentId">;

/** A value as one line of text, cut to `PREVIEW_CHARS`. */
export function preview(value: unknown): string {
  const text = (typeof value === "string" ? value : JSON.stringify(value ?? null)).replace(
    /\s+/g,
    " ",
  );
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}
