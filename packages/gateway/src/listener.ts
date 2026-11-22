import pg from "pg";
import type { Logger } from "./logger";

/**
 * The one dedicated LISTEN connection of a gateway. It must go straight to
 * Postgres (a transaction pooler drops LISTEN). NOTIFY is only a wake-up and is
 * lost while nobody listens, so `onWake` also runs after every (re)connect:
 * the gateway then re-reads every unacked command.
 */
export interface CommandListener {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CommandListenerOptions {
  connectionString: string;
  ssl: false | { rejectUnauthorized: boolean };
  channel: string;
  onWake: () => void;
  logger: Logger;
  /** Reconnect backoff, doubled up to the max. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export function createCommandListener(options: CommandListenerOptions): CommandListener {
  const minBackoff = options.minBackoffMs ?? 500;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  let client: pg.Client | null = null;
  let stopped = false;
  let backoff = minBackoff;
  let retry: NodeJS.Timeout | null = null;

  async function connect(): Promise<void> {
    const next = new pg.Client({ connectionString: options.connectionString, ssl: options.ssl });
    next.on("notification", () => options.onWake());
    next.on("error", (err) => {
      options.logger.warn({ err: { message: err.message } }, "listen connection failed");
      void next.end().catch(() => {});
    });
    next.on("end", () => {
      if (client === next) client = null;
      scheduleReconnect();
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${options.channel}`);
    } catch (err) {
      options.logger.warn({ err: { message: (err as Error).message } }, "listen connect failed");
      await next.end().catch(() => {});
      return;
    }
    if (stopped) {
      await next.end().catch(() => {});
      return;
    }
    client = next;
    backoff = minBackoff;
    options.logger.info({ channel: options.channel }, "listening for commands");
    options.onWake();
  }

  function scheduleReconnect(): void {
    if (stopped || retry) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxBackoff);
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, delay);
  }

  return {
    async start() {
      stopped = false;
      await connect();
      if (!client) scheduleReconnect();
    },
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = null;
      const current = client;
      client = null;
      await current?.end().catch(() => {});
    },
  };
}
