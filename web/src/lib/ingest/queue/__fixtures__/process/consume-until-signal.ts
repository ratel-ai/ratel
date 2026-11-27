/**
 * A process that consumes and stops on a signal, as `instrumentation.node.ts` wires it for
 * `APP_ROLE=all`. `consumer.test.ts` runs it and sends the signal.
 */
import { startIngestConsumer, stopConsumerOnSignal } from "@/lib/ingest/queue/consumer";
import { envelope } from "@/lib/ingest/queue/port/test-support/conformance";
import { createMemoryQueue } from "@/lib/ingest/queue/port/test-support/memory-queue";

const say = (line: string) => process.stdout.write(`${line}\n`);
const queue = createMemoryQueue();
const consumer = startIngestConsumer({
  queue: {
    publish: queue.publish,
    consume: (handler, options) =>
      queue.consume(handler, {
        onSettled: (settled) => {
          say(`settled ${settled.outcome}`);
          options?.onSettled?.(settled);
        },
      }),
  },
  handler: async () => {
    say("in hand");
    await new Promise((resolve) => setTimeout(resolve, 600));
    say("handled");
    return { outcome: "ack" };
  },
});
stopConsumerOnSignal(consumer, {
  on: (signal, listener) => process.on(signal, listener),
  exit: (code) => process.exit(code),
  ownsExit: true,
  beforeExit: async () => {
    say("flushed");
  },
});
// The HTTP server of a real process.
setInterval(() => undefined, 1_000);
const projectId = "11111111-1111-4111-8111-111111111111";
void queue.publish(envelope(projectId)).then(() => queue.publish(envelope(projectId)));
