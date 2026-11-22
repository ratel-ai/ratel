import { z } from "zod";

/**
 * A use case (RC-1124): a named, project-scoped selector of model calls. A
 * turn matches when its task (`trace_turns.workflow_id`) is one of `taskIds`
 * OR its ask landed in one of `intentIds`; the call filter then keeps only
 * the calls of those turns with one of `models` and one of `spanNames`. The
 * date range bounds the turns by `ended_at`; with none, the last
 * {@link DEFAULT_WINDOW_DAYS} days.
 */

export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_USE_CASE_NAME = 80;
const MAX_IDS = 50;
const MAX_FILTER_VALUES = 20;

export interface UseCaseSelector {
  taskIds: string[];
  intentIds: string[];
  dateRange?: { from: string; to: string };
  callFilter?: { models?: string[]; spanNames?: string[] };
}

export interface UseCase {
  id: string;
  projectId: string;
  name: string;
  selector: UseCaseSelector;
  createdBy: string;
  createdAt: Date;
  archivedAt: Date | null;
}

export type SelectorErrorCode = "unknown_key" | "empty_selector" | "invalid_selector";

/** A selector the domain refuses. `code` is stable: the API and MCP tools return it. */
export class SelectorError extends Error {
  constructor(
    readonly code: SelectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SelectorError";
  }
}

const id = z.string().trim().min(1).max(256);
const values = z.array(z.string().trim().min(1).max(256)).max(MAX_FILTER_VALUES);

export const UseCaseSelectorSchema = z
  .object({
    taskIds: z.array(id).max(MAX_IDS).default([]),
    intentIds: z.array(z.string().uuid()).max(MAX_IDS).default([]),
    dateRange: z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
      })
      .strict()
      .refine((range) => Date.parse(range.from) < Date.parse(range.to), {
        message: "dateRange.from must be before dateRange.to.",
      })
      .optional(),
    callFilter: z
      .object({ models: values.optional(), spanNames: values.optional() })
      .strict()
      .optional(),
  })
  .strict();

export const UseCaseNameSchema = z
  .string()
  .trim()
  .min(1, "Give the use case a name.")
  .max(MAX_USE_CASE_NAME);

/** The selector, or a {@link SelectorError}: an unknown key, no task and no intent, or a bad value. */
export function parseSelector(input: unknown): UseCaseSelector {
  const parsed = UseCaseSelectorSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.code === "unrecognized_keys") {
      throw new SelectorError("unknown_key", `Unknown selector key: ${issue.keys.join(", ")}.`);
    }
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new SelectorError("invalid_selector", `${where}${issue?.message ?? "Invalid selector."}`);
  }
  const selector = normalize(parsed.data);
  if (selector.taskIds.length === 0 && selector.intentIds.length === 0) {
    throw new SelectorError("empty_selector", "Pick at least one task or intent.");
  }
  return selector;
}

/** The turns' window: the selector's date range, else the last {@link DEFAULT_WINDOW_DAYS} days before `now`. */
export function selectorWindow(selector: UseCaseSelector, now: Date): { since: Date; until: Date } {
  if (selector.dateRange)
    return { since: new Date(selector.dateRange.from), until: new Date(selector.dateRange.to) };
  return { since: new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000), until: now };
}

/** Whether the call filter keeps a call. An empty or missing list keeps every value. */
export function callMatches(
  filter: UseCaseSelector["callFilter"],
  call: { model: string | null; spanName: string | null },
): boolean {
  if (filter?.models?.length && (call.model === null || !filter.models.includes(call.model)))
    return false;
  if (
    filter?.spanNames?.length &&
    (call.spanName === null || !filter.spanNames.includes(call.spanName))
  )
    return false;
  return true;
}

function normalize(selector: z.infer<typeof UseCaseSelectorSchema>): UseCaseSelector {
  const unique = (list: readonly string[]) => [...new Set(list)];
  const models = unique(selector.callFilter?.models ?? []);
  const spanNames = unique(selector.callFilter?.spanNames ?? []);
  return {
    taskIds: unique(selector.taskIds),
    intentIds: unique(selector.intentIds),
    ...(selector.dateRange ? { dateRange: selector.dateRange } : {}),
    ...(models.length || spanNames.length
      ? {
          callFilter: {
            ...(models.length ? { models } : {}),
            ...(spanNames.length ? { spanNames } : {}),
          },
        }
      : {}),
  };
}
