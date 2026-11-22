import type { RunResult } from "./runs.js";
import type { RunUsage } from "./usage-meter.js";

// The end of a run in the worker (RC-1234). The controller stops a run-state
// instance as soon as it stores run.end, so the run's spans are flushed first,
// within a bound: a stuck exporter must not hold the run. run.end then carries
// the usage the worker measured, unless run() reported its own.

/** How long run.end waits for the trace export. */
export const RUN_END_FLUSH_TIMEOUT_MS = 5_000;

export interface FinishPorts {
  /** Flushes the run's spans to Ratel. Absent: no exporter. */
  readonly flush?: () => Promise<void>;
  /** The usage measured for the trace (UsageMeter.take). */
  readonly usage?: (traceId: string) => RunUsage | undefined;
  readonly send: (result: RunResult) => void;
  readonly warn: (message: string) => void;
  readonly timeoutMs?: number;
}

export async function finishRun(result: RunResult, ports: FinishPorts): Promise<void> {
  if (ports.flush)
    await flushWithin(ports.flush, ports.timeoutMs ?? RUN_END_FLUSH_TIMEOUT_MS, ports.warn);
  const measured = !result.usage && result.traceId ? ports.usage?.(result.traceId) : undefined;
  ports.send(measured ? { ...result, usage: measured } : result);
}

/** Awaits the flush, or the timeout, whichever comes first. Never throws. */
export async function flushWithin(
  flush: () => Promise<void>,
  timeoutMs: number,
  warn: (message: string) => void,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([flush().then(() => "flushed" as const), timeout]);
    if (outcome === "timeout")
      warn(`trace export did not finish in ${timeoutMs} ms; the run ends without waiting`);
  } catch (err) {
    warn(`trace export failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}
