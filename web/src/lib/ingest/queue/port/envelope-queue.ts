import type { IngestConsumer, IngestHandler, IngestQueue } from "@/lib/contracts/ingest-queue";
import type { Envelope } from "@/lib/ingest/queue/envelope";

/** The core's queue: one message is one accepted request. */
export type EnvelopeQueue = IngestQueue<Envelope>;
export type EnvelopeHandler = IngestHandler<Envelope>;
export type EnvelopeConsumer = IngestConsumer;
