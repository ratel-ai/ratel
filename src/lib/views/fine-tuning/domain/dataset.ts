import { z } from "zod";
import type { FrozenOverrides } from "./overrides";
import type { RedactionCounts } from "./redaction";
import { type BuildSettings, buildSettings, DEDUP_RULES, type DropCounts } from "./rows";
import type { UseCaseSelector } from "./use-case";

/**
 * A dataset version (RC-1128): one immutable build of a use case. It starts
 * `building`, gets rows appended page by page, and ends `ready` or `failed`.
 * Once it leaves `building`, nothing changes its rows: the store has no row
 * update, and a database trigger refuses one.
 */

export const DATASET_STATUSES = ["building", "ready", "failed"] as const;
export type DatasetStatus = (typeof DATASET_STATUSES)[number];

/** Why a build failed or was refused. Stable: the API, the job and MCP return it. */
export const DATASET_FAILURES = [
  "flag_off",
  "no_consent",
  "use_case_not_found",
  "too_large",
  "no_rows",
] as const;
export type DatasetFailure = (typeof DATASET_FAILURES)[number];

export const DATASET_FAILURE_MESSAGES: Record<DatasetFailure, string> = {
  flag_off: "Fine-tuning is not on for this organization.",
  no_consent:
    "An organization admin must give the training opt-in before Ratel copies model call text into a dataset.",
  use_case_not_found: "This project has no use case with that ID.",
  too_large:
    "The use case selects more rows than one dataset can hold. Narrow its date range or its call filter.",
  no_rows:
    "No model call of this use case passed the filters. Loosen the quality rules or widen the use case.",
};

/**
 * The settings a version records: the build settings, the frozen turn window
 * and (RC-1130) the use case's pins and exclusions when the build started.
 * Versions built before RC-1130 have no `overrides`; before RC-1144 they also
 * hold `splitBy`, which is ignored.
 */
export type DatasetSettings = BuildSettings & {
  window: { since: string; until: string };
  overrides?: FrozenOverrides;
  splitBy?: string;
};

export interface DatasetCounts {
  /** The use case's selected turns. */
  turns: number;
  /** Model calls read so far. */
  calls: number;
  /**
   * The last call read, in the build's call order (capture time, then event
   * id): a resumed build starts after it. Null before the first page.
   */
  cursor: { capturedAt: string; eventId: string } | null;
  train: number;
  eval: number;
  dropped: DropCounts;
  /**
   * Rows of each side the JSONL export cannot express (RC-1131): the export
   * skips them. Versions built before RC-1131 do not have it.
   */
  exportSkipped?: { train: number; eval: number };
}

export interface Dataset {
  id: string;
  projectId: string;
  useCaseId: string;
  version: number;
  status: DatasetStatus;
  settings: DatasetSettings;
  contentHash: string | null;
  counts: DatasetCounts | null;
  redactionReport: RedactionCounts | null;
  createdBy: string;
  createdAt: Date;
  failedReason: DatasetFailure | null;
}

/** What a person or a tool may set for a build. Everything has a default. */
export const BuildInputSchema = z
  .object({
    filters: z
      .object({ noError: z.boolean().default(false), noSelfCorrection: z.boolean().default(false) })
      .strict()
      .default({ noError: false, noSelfCorrection: false }),
    dedup: z.enum(DEDUP_RULES).default("near"),
    seed: z.number().int().min(0).max(2_147_483_647).default(0),
    evalFraction: z.number().min(0).max(0.5).default(0.1),
  })
  .strict();

export type BuildInput = z.input<typeof BuildInputSchema>;

/** The settings of a new version: the parsed input, the use case's selector, the window and its overrides. */
export function datasetSettings(
  selector: UseCaseSelector,
  input: z.output<typeof BuildInputSchema>,
  window: { since: Date; until: Date },
  overrides: FrozenOverrides = { pinned: [], excluded: [] },
): DatasetSettings {
  return {
    ...buildSettings(selector, input),
    window: { since: window.since.toISOString(), until: window.until.toISOString() },
    overrides,
  };
}

/** What a page, a route and a tool show of a version. Never row text. */
export function viewOfDataset(dataset: Dataset) {
  return {
    id: dataset.id,
    useCaseId: dataset.useCaseId,
    version: dataset.version,
    status: dataset.status,
    settings: dataset.settings,
    contentHash: dataset.contentHash,
    // The resume cursor is the job's own bookkeeping: not shown.
    counts: dataset.counts
      ? {
          turns: dataset.counts.turns,
          calls: dataset.counts.calls,
          train: dataset.counts.train,
          eval: dataset.counts.eval,
          dropped: dataset.counts.dropped,
          exportSkipped: dataset.counts.exportSkipped ?? null,
        }
      : null,
    redactionReport: dataset.redactionReport,
    failedReason: dataset.failedReason,
    failedMessage: dataset.failedReason ? DATASET_FAILURE_MESSAGES[dataset.failedReason] : null,
    createdBy: dataset.createdBy,
    createdAt: dataset.createdAt.toISOString(),
  };
}

export type DatasetView = ReturnType<typeof viewOfDataset>;
