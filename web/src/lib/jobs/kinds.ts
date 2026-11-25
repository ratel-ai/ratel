/** The job kind that reads an accepted import in the background (RC-40). */
export const RUN_IMPORT_JOB = "run_import" as const;

/** The job kind that builds a pushed sandbox version into an image. */
export const SANDBOX_IMAGE_BUILD_JOB = "sandbox_image_build" as const;

/**
 * The kinds that can take many minutes. Each has its own lane in the worker, and a running one does
 * not count against its project's cap.
 */
export const LONG_JOB_KINDS = [RUN_IMPORT_JOB, SANDBOX_IMAGE_BUILD_JOB] as const;
