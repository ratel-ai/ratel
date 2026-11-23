import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { type Config, getConfig } from "@/config";
import { appRole } from "@/lib/jobs/role";
import { getLogger } from "@/lib/platform/logger";

const logger = getLogger("observability/process");

/** How often each process reports its memory and event loop (RC-216). */
export const PROCESS_STATS_EVERY_MS = 60_000;

const MB = 1024 * 1024;

export interface ProcessStats {
  role: string;
  heap_used_mb: number;
  heap_total_mb: number;
  rss_mb: number;
  external_mb: number;
  /** p99 event loop delay over the last interval; high means the process is starved. */
  event_loop_p99_ms: number;
}

/** One reading, from Node's own numbers; pure for tests. */
export function readProcessStats(
  memory: NodeJS.MemoryUsage,
  loopDelay: Pick<IntervalHistogram, "percentile"> | null,
  role: string,
): ProcessStats {
  const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10;
  return {
    role,
    heap_used_mb: mb(memory.heapUsed),
    heap_total_mb: mb(memory.heapTotal),
    rss_mb: mb(memory.rss),
    external_mb: mb(memory.external),
    event_loop_p99_ms: loopDelay ? Math.round(loopDelay.percentile(99) / 1e4) / 100 : 0,
  };
}

let started = false;

/**
 * Log `process_stats` once a minute from this process (app or worker), so a
 * memory climb shows in Datadog before ECS kills the task: the October
 * outages left nothing in the logs because the kernel killed the container
 * first. The timer never keeps the process alive.
 */
export function startProcessStats(config: Pick<Config, "app"> = getConfig()): void {
  if (started) return;
  started = true;
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const role = appRole(config);
  const timer = setInterval(() => {
    try {
      logger.info(readProcessStats(process.memoryUsage(), loopDelay, role), "process_stats");
      loopDelay.reset();
    } catch (err) {
      logger.error({ err }, "process stats read failed");
    }
  }, PROCESS_STATS_EVERY_MS);
  timer.unref();
}
