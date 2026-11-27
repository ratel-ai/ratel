import { type Config, getConfig } from "@/config";

/**
 * The ingest queue's switch and knobs (RTL-314, ADR-0009). Off, every ingest route decodes and
 * writes in the request, as before.
 */
export function ingestQueueEnabled(config: Pick<Config, "ingest"> = getConfig()): boolean {
  return config.ingest.experimentalQueue;
}

export interface IngestQueueSettings {
  /** Batches one project may have persisting at once, across every process; 0 is no cap. */
  persistPerProject: number;
  /** Batches one process persists at once. */
  persistConcurrency: number;
  /** Tries before a batch is marked failed. */
  maxAttempts: number;
}

export function ingestQueueSettings(
  config: Pick<Config, "ingest"> = getConfig(),
): IngestQueueSettings {
  return {
    persistPerProject: config.ingest.persistPerProject,
    persistConcurrency: config.ingest.persistConcurrency,
    maxAttempts: config.ingest.batchMaxAttempts,
  };
}
