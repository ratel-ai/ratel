import type { SettledDelivery } from "@/lib/contracts/ingest-queue";
import type {
  EnvelopeConsumer,
  EnvelopeHandler,
  EnvelopeQueue,
} from "@/lib/ingest/queue/port/envelope-queue";
import { getLogger } from "@/lib/platform/logger";

const logger = getLogger("ingest:consumer");
const GLOBAL_KEY = Symbol.for("ratel.platform.ingest-consumer");

/** How often the counts are logged, when there is something to count. */
export const COUNTS_EVERY_MS = 60_000;

/** Deliveries since the last counts line. `processed` are the acknowledged ones. */
export interface IngestCounts {
  processed: number;
  retried: number;
  outages: number;
  dead_lettered: number;
}

type ConsumerLog = Pick<ReturnType<typeof getLogger>, "info" | "warn" | "error">;

export interface IngestConsumerDeps {
  queue: EnvelopeQueue;
  handler: EnvelopeHandler;
  log?: ConsumerLog;
}

/**
 * Reads the ingest queue in this process, once: a second call returns the consumer already
 * running, so a dev server's module reloads do not stack consumers. Each retry and dead letter is
 * a log line, and the counts are one line a minute.
 */
export function startIngestConsumer({
  queue,
  handler,
  log = logger,
}: IngestConsumerDeps): EnvelopeConsumer {
  const globals = globalThis as Record<symbol, EnvelopeConsumer | undefined>;
  const existing = globals[GLOBAL_KEY];
  if (existing) return existing;

  let counts = noCounts();
  const logCounts = () => {
    if (Object.values(counts).some((count) => count > 0)) {
      log.info({ ...counts }, "ingest_queue_processed");
    }
    counts = noCounts();
  };
  const consumer = queue.consume(handler, {
    onSettled: (settled) => {
      counts[COUNT_OF[settled.outcome]] += 1;
      logSettled(settled, log);
    },
  });
  const report = setInterval(logCounts, COUNTS_EVERY_MS);
  report.unref();
  log.info({}, "ingest consumer started");

  let stopping: Promise<void> | undefined;
  const handle: EnvelopeConsumer = {
    stop: () => {
      stopping ??= (async () => {
        clearInterval(report);
        await consumer.stop();
        if (globals[GLOBAL_KEY] === handle) globals[GLOBAL_KEY] = undefined;
        logCounts();
        log.info({}, "ingest consumer stopped");
      })();
      return stopping;
    },
  };
  globals[GLOBAL_KEY] = handle;
  return handle;
}

const COUNT_OF: Record<SettledDelivery["outcome"], keyof IngestCounts> = {
  ack: "processed",
  retry: "retried",
  outage: "outages",
  "dead-letter": "dead_lettered",
};

function noCounts(): IngestCounts {
  return { processed: 0, retried: 0, outages: 0, dead_lettered: 0 };
}

function logSettled(settled: SettledDelivery, log: ConsumerLog): void {
  if (settled.outcome === "ack") return;
  const fields = {
    project_id: settled.projectId,
    message_id: settled.messageId,
    attempt: settled.attempt,
    reason: settled.reason,
  };
  if (settled.outcome === "dead-letter") log.error(fields, "ingest_message_dead_lettered");
  else if (settled.outcome === "outage") log.warn(fields, "ingest_store_unavailable");
  else log.warn(fields, "ingest_message_retried");
}

export interface StopOnSignalDeps {
  on: (signal: "SIGTERM" | "SIGINT", listener: () => void) => void;
  exit: (code: number) => void;
  /** Whether this handler ends the process (`NEXT_MANUAL_SIG_HANDLE`), or Next does. */
  ownsExit: boolean;
  beforeExit?: () => Promise<void>;
}

/**
 * The stop of a process that consumes and has no worker loop (`APP_ROLE=all`): the message in hand
 * is finished and acknowledged, the telemetry is flushed, and the process exits. A second signal
 * exits at once, and the message is delivered again.
 */
export function stopConsumerOnSignal(
  consumer: EnvelopeConsumer,
  { on, exit, ownsExit, beforeExit }: StopOnSignalDeps,
): void {
  let stopping = false;
  const stop = () => {
    if (stopping) {
      if (ownsExit) exit(1);
      return;
    }
    stopping = true;
    void consumer
      .stop()
      .then(() => beforeExit?.())
      .catch((error: unknown) => {
        logger.error({ err: error }, "ingest consumer stop failed");
      })
      .then(() => {
        if (ownsExit) exit(0);
      });
  };
  on("SIGTERM", stop);
  on("SIGINT", stop);
}
