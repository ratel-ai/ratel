import { z } from "zod";
import { serializeSkill } from "@/lib/catalog/http";
import type { Skill } from "@/lib/catalog/schema";

/**
 * Response-shaping rules for MCP results.
 *
 * The consumer of every byte here is an LLM's context window, so the failure
 * mode is not a slow response: it is an answer that costs the agent more
 * context than the question was worth. That is precisely the waste this product
 * exists to measure, so the surface holds itself to it: summarized rows by
 * default, hard caps, explicit truncation markers, and drill-down operations
 * for the cases where full detail is genuinely wanted.
 */
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 50;

/** The `limit` param shared by list operations. */
export const limitParam = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe(`Maximum rows to return (max ${MAX_LIMIT}).`);

/** How much skill/tool prose to carry inline before pointing at a detail op. */
export const BODY_PREVIEW_CHARS = 600;

export interface Capped<T> {
  rows: readonly T[];
  truncated: boolean;
}

/**
 * Apply a row cap, reporting whether anything was dropped.
 *
 * Callers should query `limit + 1` where possible so the marker reflects
 * reality rather than "we happened to fill the page".
 */
export function capRows<T>(rows: readonly T[], limit: number): Capped<T> {
  if (rows.length <= limit) return { rows, truncated: false };
  return { rows: rows.slice(0, limit), truncated: true };
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
}

export function truncateText(
  value: string | null | undefined,
  max = BODY_PREVIEW_CHARS,
): TruncatedText {
  if (!value) return { text: "", truncated: false };
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, max)}…`, truncated: true };
}

/** Accumulates truncation across a multi-part result. */
export class TruncationTracker {
  private truncated = false;

  mark(truncated: boolean): void {
    if (truncated) this.truncated = true;
  }

  take<T>(capped: Capped<T>): readonly T[] {
    this.mark(capped.truncated);
    return capped.rows;
  }

  text(value: string | null | undefined, max?: number): string {
    const result = truncateText(value, max);
    this.mark(result.truncated);
    return result.text;
  }

  get value(): boolean {
    return this.truncated;
  }
}

/**
 * A skill in list context: everything identifying, nothing bulky.
 *
 * `body` is the whole point of a skill and frequently kilobytes long, so it is
 * previewed here and served in full only by `get_skill`.
 */
export function summarizeSkill(row: Skill, tracker?: TruncationTracker) {
  const full = serializeSkill(row);
  const preview = truncateText(full.body, BODY_PREVIEW_CHARS);
  tracker?.mark(preview.truncated);
  return {
    id: full.id,
    name: full.name,
    description: full.description,
    searchableDescription: full.searchableDescription,
    status: full.status,
    version: full.version,
    tags: full.tags,
    tools: full.tools,
    endUserId: full.endUserId,
    model: full.model,
    bodyPreview: preview.text,
    bodyTruncated: preview.truncated,
    bodyChars: full.body?.length ?? 0,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
    publishedAt: full.publishedAt,
  };
}

/** The full record, for `get_skill`. */
export function detailSkill(row: Skill) {
  return serializeSkill(row);
}

/** Round to a sane precision so floats do not eat tokens with noise digits. */
export function round(value: number | null | undefined, places = 4): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
