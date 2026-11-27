import { type Envelope, encodeEnvelope } from "@/lib/ingest/queue/envelope";
import type { EnvelopeConsumer, EnvelopeQueue } from "@/lib/ingest/queue/port/envelope-queue";
import {
  RETRY_POLICY,
  type RetryPolicy,
  readFrame,
  runHandler,
  type Settlement,
  settle,
} from "@/lib/ingest/queue/port/settle";
import type { DeadLetter } from "./conformance";

type Entry = {
  frame: Uint8Array;
  attempts: number;
  outages: number;
  notBefore: number;
  firstFailedAt: Date | null;
};

/** What the in-memory queues of one test share, as processes share a database. */
export class MemoryQueueStore {
  readonly projects = new Map<string, Entry[]>();
  readonly claimed = new Set<string>();
  readonly deadLetters: DeadLetter[] = [];
  readonly consumers = new Set<() => void>();

  push(projectId: string, frame: Uint8Array): void {
    const entries = this.projects.get(projectId) ?? [];
    this.projects.set(projectId, entries);
    entries.push({ frame, attempts: 0, outages: 0, notBefore: 0, firstFailedAt: null });
    this.wake();
  }

  wake(): void {
    for (const pump of this.consumers) pump();
  }
}

/** The queue port in memory, for tests only: nothing it holds is durable. */
export function createMemoryQueue(
  store = new MemoryQueueStore(),
  policy: RetryPolicy = RETRY_POLICY,
): EnvelopeQueue {
  return {
    async publish(envelope: Envelope) {
      store.push(envelope.projectId, encodeEnvelope(envelope));
    },
    consume(handler, options = {}): EnvelopeConsumer {
      const inHand = new Set<Promise<void>>();
      const timers = new Set<NodeJS.Timeout>();
      let stopped = false;

      const deliver = async (projectId: string, entries: Entry[]): Promise<void> => {
        const entry = entries[0];
        const read = readFrame(entry.frame);
        entry.attempts += 1;
        const attempt = entry.attempts;
        const result = read.ok
          ? await runHandler(handler, read.envelope, { attempt })
          : read.result;
        const settlement = settle(result, { attempt, outages: entry.outages }, policy);
        const messageId = read.ok ? read.envelope.id : null;
        apply(entry, entries, messageId, settlement);
        store.claimed.delete(projectId);
        options.onSettled?.({
          messageId,
          projectId,
          attempt,
          outcome: settlement.action === "dead-letter" ? "dead-letter" : result.outcome,
          reason: settlement.action === "ack" ? null : settlement.reason,
        });
      };

      const apply = (
        entry: Entry,
        entries: Entry[],
        id: string | null,
        settlement: Settlement,
      ): void => {
        if (settlement.action === "redeliver" && settlement.outage) {
          entry.attempts -= 1;
          entry.outages += 1;
        } else if (settlement.action !== "ack") {
          entry.firstFailedAt ??= new Date();
        }
        if (settlement.action === "redeliver") {
          entry.notBefore = Date.now() + settlement.waitMs;
          return;
        }
        entries.shift();
        if (settlement.action === "ack") return;
        store.deadLetters.push({
          id,
          frame: entry.frame,
          reason: settlement.reason,
          deliveries: entry.attempts,
          firstFailedAt: entry.firstFailedAt ?? new Date(),
          lastFailedAt: new Date(),
        });
      };

      const pump = (): void => {
        if (stopped) return;
        for (const [projectId, entries] of store.projects) {
          const head = entries[0];
          if (!head || store.claimed.has(projectId)) continue;
          const waitMs = head.notBefore - Date.now();
          if (waitMs > 0) {
            const timer = setTimeout(() => {
              timers.delete(timer);
              pump();
            }, waitMs);
            timers.add(timer);
            continue;
          }
          store.claimed.add(projectId);
          const delivery = deliver(projectId, entries).finally(() => {
            inHand.delete(delivery);
            store.wake();
          });
          inHand.add(delivery);
        }
      };

      store.consumers.add(pump);
      setImmediate(pump);
      return {
        async stop() {
          stopped = true;
          store.consumers.delete(pump);
          for (const timer of timers) clearTimeout(timer);
          await Promise.all(inHand);
        },
      };
    },
  };
}
