import { Client } from "pg";
import { sslConfig } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { runChannel } from "../domain/channels";

/**
 * Wake-ups for run readers (the SSE streams), over ONE dedicated LISTEN
 * connection per app task, whatever the number of open browsers: a channel is
 * LISTENed while at least one reader follows that run. NOTIFY is only a
 * wake-up and can be lost (a reconnect, a missed LISTEN), so readers also poll;
 * after every (re)connect every reader is woken to re-read.
 */
export interface RunNotifications {
  /** Calls `onWake` on each NOTIFY of the run. Returns the unsubscribe. */
  subscribe(runId: string, onWake: () => void): () => void;
}

const logger = getLogger("sandboxes/run-notifications");
const MAX_BACKOFF_MS = 30_000;

export function createPgRunNotifications(connectionString: string): RunNotifications {
  const readers = new Map<string, Set<() => void>>();
  let client: Client | null = null;
  let connecting: Promise<void> | null = null;
  let backoff = 500;

  function connect(): Promise<void> {
    if (client || connecting) return connecting ?? Promise.resolve();
    connecting = (async () => {
      const next = new Client({ connectionString, ssl: sslConfig(connectionString) });
      next.on("notification", (msg) => {
        for (const wake of readers.get(msg.channel) ?? []) wake();
      });
      next.on("error", (err) => {
        logger.warn({ err: { message: err.message } }, "run listen connection failed");
        void next.end().catch(() => {});
      });
      next.on("end", () => {
        if (client === next) client = null;
        if (readers.size > 0) retry();
      });
      try {
        await next.connect();
        for (const channel of readers.keys()) await next.query(`LISTEN ${channel}`);
        client = next;
        backoff = 500;
        for (const wakes of readers.values()) for (const wake of wakes) wake();
      } catch (err) {
        logger.warn({ err: { message: (err as Error).message } }, "run listen connect failed");
        await next.end().catch(() => {});
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  function retry(): void {
    const delay = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    setTimeout(() => void connect(), delay).unref();
  }

  function listen(channel: string, command: "LISTEN" | "UNLISTEN"): void {
    // Without a client the next connect LISTENs every channel with readers.
    client
      ?.query(`${command} ${channel}`)
      .catch((err: Error) =>
        logger.warn({ err: { message: err.message }, command }, "run listen command failed"),
      );
  }

  return {
    subscribe(runId, onWake) {
      const channel = runChannel(runId);
      const wakes = readers.get(channel) ?? new Set();
      const first = wakes.size === 0;
      wakes.add(onWake);
      readers.set(channel, wakes);
      if (first) listen(channel, "LISTEN");
      void connect();
      return () => {
        wakes.delete(onWake);
        if (wakes.size > 0) return;
        readers.delete(channel);
        listen(channel, "UNLISTEN");
      };
    },
  };
}

let shared: RunNotifications | undefined;

/** The process-wide instance over DATABASE_URL. */
export function sharedRunNotifications(): RunNotifications {
  if (!shared) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    shared = createPgRunNotifications(url);
  }
  return shared;
}
