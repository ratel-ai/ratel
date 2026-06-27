import { buildRollup, type Rollup, type TrackInput, type Transport } from "@ratel-ai/sdk";

/**
 * The Ratel cloud analytics client (ADR-0013) — the TypeScript mirror of the
 * Python SDK's `RatelClient`. Records one usage *rollup* per agent interaction
 * (assembled by `@ratel-ai/sdk`'s `buildRollup`) and ships it to
 * `POST {host}/api/v1/events` — the exact shape Ratel's dashboard renders.
 * Best-effort and batched; never throws into caller code, and absent an API key
 * it is a no-op.
 */

/** Read an environment variable without a hard dependency on Node's `process` types. */
function envVar(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.[name];
}

/** Register a best-effort process-exit flush without depending on Node's `process` types. */
function onBeforeExit(handler: () => void): (() => void) | undefined {
  const proc = (
    globalThis as {
      process?: {
        on?: (event: string, handler: () => void) => void;
        off?: (event: string, handler: () => void) => void;
      };
    }
  ).process;
  if (!proc?.on) return undefined;
  proc.on("beforeExit", handler);
  return () => proc.off?.("beforeExit", handler);
}

export interface RatelClientOptions {
  apiKey?: string;
  host?: string;
  enabled?: boolean;
  /** Fraction of interactions to record, 0..1 (default 1 = all). */
  sampleRate?: number;
  /** Flush automatically once this many rollups are buffered (default 50). */
  flushAt?: number;
  /** Flush automatically this long after the last `track()` (default 1000ms). */
  flushIntervalMs?: number;
  /** Per-request timeout for the default fetch transport (default 5000ms). */
  timeoutMs?: number;
  /** Override the network transport — primarily for tests. */
  transport?: Transport;
}

export class RatelClient {
  private readonly apiKey: string | undefined;
  private readonly eventsUrl: string;
  private readonly enabled: boolean;
  private readonly sampleRate: number;
  private readonly flushAt: number;
  private readonly flushIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly transport: Transport | undefined;
  private buffer: Rollup[] = [];
  private readonly warned = new Set<string>();
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private removeExitHandler: (() => void) | undefined;

  constructor(options: RatelClientOptions = {}) {
    this.apiKey = options.apiKey ?? envVar("RATEL_API_KEY");
    const host = (options.host ?? envVar("RATEL_HOST") ?? "https://cloud.ratel.sh").replace(
      /\/+$/,
      "",
    );
    this.eventsUrl = `${host}/api/v1/events`;
    this.enabled = options.enabled ?? Boolean(this.apiKey);
    this.sampleRate = options.sampleRate ?? 1;
    this.flushAt = options.flushAt ?? 50;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.transport = options.transport;
    // For real (network) usage, ship whatever is buffered when the process winds
    // down. Skipped under a custom transport so tests don't accumulate listeners.
    if (this.canExport && this.transport == null) {
      this.removeExitHandler = onBeforeExit(() => {
        void this.flush();
      });
    }
  }

  /** True when the client should ship: a transport is set, or it's enabled with a key. */
  get canExport(): boolean {
    return this.transport != null || (this.enabled && Boolean(this.apiKey));
  }

  /** Record one interaction's usage rollup. Best-effort; never throws. */
  track(input: TrackInput): void {
    if (!this.canExport) return;
    if (this.sampleRate < 1 && Math.random() >= this.sampleRate) return;
    try {
      this.buffer.push(buildRollup(input));
      if (this.buffer.length >= this.flushAt) {
        void this.flush();
      } else {
        this.scheduleFlush();
      }
    } catch {
      // assembling/buffering must never break the caller
    }
  }

  /** Send everything buffered. Resolves once the send settles (or is swallowed). */
  async flush(): Promise<void> {
    if (this.scheduled !== undefined) {
      clearTimeout(this.scheduled);
      this.scheduled = undefined;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.send(batch);
    } catch {
      // best-effort: a failed send is dropped, never surfaced
    }
  }

  /** Stop background flushing and ship anything still buffered. */
  async shutdown(): Promise<void> {
    if (this.removeExitHandler) {
      this.removeExitHandler();
      this.removeExitHandler = undefined;
    }
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.scheduled !== undefined) return;
    const handle = setTimeout(() => {
      this.scheduled = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    // An unref'd timer never keeps the process alive on its own.
    (handle as unknown as { unref?: () => void }).unref?.();
    this.scheduled = handle;
  }

  private async send(batch: ReadonlyArray<Rollup>): Promise<void> {
    if (this.transport) {
      await this.transport(batch);
      return;
    }
    const body = JSON.stringify(batch);
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    let delay = 200;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(this.eventsUrl, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        if (response.ok) return;
        if (response.status >= 400 && response.status < 500) {
          // Bad key/payload — retrying won't help. Drop and warn once.
          this.warnOnce(
            `http_${response.status}`,
            `ratel: ingest rejected (${response.status}); dropping batch`,
          );
          return;
        }
        // 5xx — fall through to retry.
      } catch {
        if (attempt === 2) {
          this.warnOnce("network", "ratel: ingest unreachable; dropping batch");
        }
      } finally {
        clearTimeout(timer);
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 200));
        delay *= 2;
      }
    }
    this.warnOnce("retries", "ratel: ingest failed after retries; dropping batch");
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }
}

let globalClient: RatelClient | null = null;

/** The process-wide client, created from the environment on first use. */
export function getClient(): RatelClient {
  if (globalClient === null) {
    globalClient = new RatelClient();
  }
  return globalClient;
}

/** Replace the process-wide client with one built from `options`, shutting down the old. */
export function configure(options: RatelClientOptions): RatelClient {
  const previous = globalClient;
  globalClient = new RatelClient(options);
  if (previous) void previous.shutdown();
  return globalClient;
}

/** Install (or clear) the process-wide client. Primarily for tests. */
export function setGlobalClient(client: RatelClient | null): void {
  globalClient = client;
}
