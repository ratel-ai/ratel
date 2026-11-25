#!/usr/bin/env tsx
/**
 * One side of a local migration run: the internal routes (docs/internal-api.md) over a database, with
 * this core's real processing behind them. Not a deployment: no console, no API keys of its own.
 *
 *   SIDE=cloud|app PORT=… RATEL_INTERNAL_SECRET=… DATABASE_URL=… stand-in-side
 *
 * `cloud` stores what a relay delivers. `app` reads the topics of the table `ingest_topics`, each in its
 * own consumer group, as the worker does (INGEST_KAFKA_BROKERS). GET /count answers how many spans are
 * stored. POST /quiet {"quiet": false} keeps a hold from becoming quiet.
 */
import { createServer, type IncomingMessage } from "node:http";
import { Pool } from "pg";
import { configuredHandler } from "@/ingest-consumer";
import type { Envelope } from "@/lib/ingest/queue/envelope";
import { createKafkaClient } from "@/lib/ingest/queue/kafka/client";
import { createKafkaQueue } from "@/lib/ingest/queue/kafka/kafka-queue";
import type { EnvelopeConsumer } from "@/lib/ingest/queue/port/envelope-queue";

const { SIDE, PORT, RATEL_INTERNAL_SECRET, DATABASE_URL, INGEST_KAFKA_BROKERS = "" } = process.env;
if ((SIDE !== "cloud" && SIDE !== "app") || !PORT || !RATEL_INTERNAL_SECRET || !DATABASE_URL) {
  throw new Error("SIDE, PORT, RATEL_INTERNAL_SECRET and DATABASE_URL are needed");
}
const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
const handler = configuredHandler({});
const holds = new Map<string, { state: string; since: string }>();
let quiet = true;

const read = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const status = (ids: string[]) => {
  const all = ids.map((id) => holds.get(id));
  const state = all.every(Boolean) ? (all[0]?.state ?? "none") : "none";
  return { state, since: all[0]?.since ?? null, projectIds: [], runningJobs: 0, queuedJobs: 0, openTransactions: 0, quiet: state !== "none" && quiet };
};

async function held(projectId: string): Promise<boolean> {
  if (holds.has(projectId)) return true;
  const { rows } = await pool.query("select organization_id::text as id from projects where id = $1", [projectId]);
  return rows.length > 0 && holds.has(rows[0].id);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const body = await read(req);
  const json = (code: number, value: unknown, headers = {}) =>
    res.writeHead(code, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
  try {
    if (url.pathname === "/count") {
      const { rows } = await pool.query("select trace_id from otel_spans where name = 'migration e2e'");
      return json(200, rows.map((row) => row.trace_id));
    }
    if (url.pathname === "/quiet") {
      quiet = JSON.parse(body.toString()).quiet;
      return json(200, {});
    }
    if (!url.pathname.startsWith("/api/internal/")) return json(200, { side: SIDE });
    if (req.headers.authorization !== `Bearer ${RATEL_INTERNAL_SECRET}`) return json(401, {});
    if (url.pathname === "/api/internal/keys/resolve") {
      const { rows } = await pool.query(
        `select k.id::text as "keyId", k.project_id::text as "projectId", p.organization_id::text as "organizationId"
         from api_keys k join projects p on p.id = k.project_id where k.key_hash = $1 and k.revoked_at is null`,
        [JSON.parse(body.toString()).keyHash],
      );
      if (rows.length === 0) return json(200, { found: false });
      return json(200, {
        found: true,
        ...rows[0],
        scopes: ["*"],
        ingest: ["ingest:traces", "ingest:logs", "ingest:events"],
        expiresAt: null,
        keyPolicy: { access: "full", publishable: false, sharedKeyLimits: false, appendOnlyIngest: false },
        limits: { shared: null, events: { perMinute: 120, burst: 240 } },
        quota: { limit: null, used: null, exceeded: false },
      });
    }
    if (url.pathname === "/api/internal/holds") {
      const query = url.searchParams;
      const asked = req.method === "POST" ? JSON.parse(body.toString()) : {
        organizationId: query.get("organizationId") ?? undefined,
        projectIds: query.getAll("projectId"),
      };
      const ids: string[] = asked.organizationId ? [asked.organizationId] : asked.projectIds;
      for (const id of req.method === "POST" ? ids : []) {
        if (asked.action === "clear") holds.delete(id);
        else holds.set(id, { state: asked.action === "move" ? "moved" : "held", since: holds.get(id)?.since ?? new Date().toISOString() });
      }
      return json(200, status(ids));
    }
    const signal = /^\/api\/internal\/ingest\/(traces|logs|events)$/.exec(url.pathname)?.[1];
    if (signal && SIDE === "cloud") {
      const head = (name: string) => String(req.headers[name] ?? "");
      const projectId = head("x-ratel-project-id");
      if (await held(projectId)) return json(503, { reason: "on_hold" }, { "retry-after": "1" });
      const envelope: Envelope = {
        version: 1,
        id: head("x-ratel-envelope-id"),
        projectId,
        organizationId: projectId,
        keyId: head("x-ratel-key-id"),
        keyPolicy: { appendOnlyIngest: false, sharedKeyLimits: false },
        signal: signal as Envelope["signal"],
        contentType: head("content-type") as Envelope["contentType"],
        contentEncoding: (head("content-encoding") || "identity") as Envelope["contentEncoding"],
        receivedAt: Number(head("x-ratel-received-at")),
        body: new Uint8Array(body),
      };
      const result = await handler(envelope, { attempt: 1 } as never);
      return result.outcome === "ack" ? json(202, {}) : json(503, result, { "retry-after": "1" });
    }
    return json(404, {});
  } catch (error) {
    console.error(error);
    return json(500, {});
  }
}).listen(Number(PORT), "0.0.0.0", () => console.log(`${SIDE} listens on ${PORT}`));

if (SIDE === "app") {
  const kafka = await createKafkaClient({ brokers: INGEST_KAFKA_BROKERS.split(","), security: "plaintext" });
  const readers = new Map<string, EnvelopeConsumer>();
  const refresh = async () => {
    const { rows } = await pool.query<{ topic: string }>("select topic from ingest_topics");
    const wanted = new Set(rows.map((row) => row.topic));
    for (const topic of wanted) {
      if (readers.has(topic)) continue;
      const queue = createKafkaQueue(kafka, {
        topics: async () => [topic],
        groupId: `ratel-ingest.${topic}`,
        deadLetterTopic: `${topic}.dead`,
      });
      readers.set(topic, queue.consume(handler, {}));
    }
    for (const [topic, reader] of readers) {
      if (wanted.has(topic)) continue;
      readers.delete(topic);
      await reader.stop();
    }
  };
  setInterval(() => void refresh().catch((error) => console.error(error)), 1_000);
}
