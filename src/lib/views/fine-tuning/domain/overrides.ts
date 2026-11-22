import { z } from "zod";
import type { DatasetSide, RowContent } from "./rows";

/**
 * The review step of a dataset (RC-1130). Decision `immutable-versions`: a
 * built version never changes, so a person corrects the selection on the use
 * case. A pinned run skips the quality filter; an excluded run never enters.
 * Same meaning as `pinned` and `excluded_at` of `task_eval_cases`: an
 * exclusion stays until a person clears it, so a later build cannot select
 * the run again. A build freezes the overrides into its settings when it
 * starts, so a change applies to the next version only.
 */

/** Rows per page of the rows route and `list_dataset_rows`. */
export const DEFAULT_ROW_PAGE = 25;
export const MAX_ROW_PAGE = 100;

export interface UseCaseOverride {
  turnId: string;
  pinned: boolean;
  excluded: boolean;
  setBy: string;
  updatedAt: Date;
}

/** The overrides a version was built with: turn ids, sorted. */
export interface FrozenOverrides {
  pinned: string[];
  excluded: string[];
}

/** One change to one run: pin or unpin it, exclude it or clear the exclusion. */
export const OverrideInputSchema = z
  .object({
    turnId: z.string().uuid(),
    pinned: z.boolean().optional(),
    excluded: z.boolean().optional(),
  })
  .strict()
  .refine((input) => input.pinned !== undefined || input.excluded !== undefined, {
    message: "Give pinned or excluded.",
  });

export type OverrideInput = z.output<typeof OverrideInputSchema>;

/** A stored row as a page, a route and a tool show it. `content` is null when the caller may not read the text. */
export interface DatasetRowView {
  ordinal: number;
  side: DatasetSide;
  turnId: string;
  traceId: string;
  spanId: string;
  capturedAt: string;
  pinned: boolean;
  excluded: boolean;
  content: RowContent | null;
}

export interface RowPageQuery {
  side: DatasetSide | null;
  /** The last ordinal of the previous page; null for the first page. */
  after: number | null;
  limit: number;
}

/** The overrides of a use case as a build reads them. */
export function frozenOverrides(overrides: readonly UseCaseOverride[]): FrozenOverrides {
  return {
    pinned: overrides
      .filter((o) => o.pinned)
      .map((o) => o.turnId)
      .sort(),
    excluded: overrides
      .filter((o) => o.excluded)
      .map((o) => o.turnId)
      .sort(),
  };
}

/**
 * The page cursor: the dataset, the side filter and the last ordinal, so a
 * cursor only continues the listing it came from.
 */
export function encodeRowCursor(
  datasetId: string,
  side: DatasetSide | null,
  ordinal: number,
): string {
  return Buffer.from(JSON.stringify([datasetId, side, ordinal]), "utf8").toString("base64url");
}

/** The last ordinal a cursor carries, or null when it is not a cursor of this listing. */
export function decodeRowCursor(
  cursor: string,
  datasetId: string,
  side: DatasetSide | null,
): number | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [id, cursorSide, ordinal] = value as unknown[];
    if (
      id !== datasetId ||
      cursorSide !== side ||
      !Number.isInteger(ordinal) ||
      (ordinal as number) < 0
    )
      return null;
    return ordinal as number;
  } catch {
    return null;
  }
}
