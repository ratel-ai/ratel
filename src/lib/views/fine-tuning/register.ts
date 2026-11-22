import type { Registration } from "@/lib/contracts/registry";
import { BUILD_DATASET_JOB } from "./build";
import { buildFineTuningDatasetJob } from "./build-deps";

/**
 * Fine-tuning's registration: the `build_fine_tuning_dataset` job (upstream's line in
 * `lib/jobs/handlers.ts`, RC-1128): a dataset version built in pages, resumed after a stop. The
 * job checks `FF_FINE_TUNING` and the training opt-in again; nothing is queued with the switch
 * off, since only a build request (the console route or `build_dataset`) queues it.
 */
export const fineTuningRegistration: Registration = {
  jobs: {
    [BUILD_DATASET_JOB]: (job) => buildFineTuningDatasetJob(job),
  },
};
