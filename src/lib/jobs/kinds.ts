/** The job kind that reads an accepted import in the background (RC-40). */
export const RUN_IMPORT_JOB = "run_import" as const;

/** The job kind that refills a project's trace `dims` after a pivot change (RC-884). */
export const REFILL_PIVOT_DIMS_JOB = "refill_pivot_dims" as const;

/** The job kind that indexes code pointers of a linked repo, a budget of symbols per run (RC-917). */
export const INDEX_REPO_CODE_JOB = "index_repo_code" as const;
