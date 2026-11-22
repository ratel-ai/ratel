import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as tables from "@/lib/platform/db/tables";
import { type ServerEventName, trackServerEvent } from "@/lib/platform/telemetry";
import { anthropicClient } from "@/lib/readings/anthropic/client";
import { createPgSandboxGatewayStore } from "@/lib/views/sandboxes/adapters/pg-gateway-store";
import type { SandboxDb } from "@/lib/views/sandboxes/adapters/pg-store";
import { GATEWAY_ID_PATTERN, gatewayChannel } from "@/lib/views/sandboxes/domain/channels";
import { MIN_TOKEN_SECRET_LENGTH } from "@/lib/views/sandboxes/domain/token";
import {
  anthropicFakeModel,
  DEFAULT_FAKE_MODEL,
} from "@/lib/views/sandboxes/fakes/adapters/anthropic-fake-model";
import {
  type CaptureEvent,
  createFakeAlerts,
} from "@/lib/views/sandboxes/fakes/adapters/fake-alerts";
import { createPgFakeStore } from "@/lib/views/sandboxes/fakes/adapters/pg-fake-store";
import { dailyCap } from "@/lib/views/sandboxes/fakes/domain/fake";
import { createFakeService, type FakeService } from "@/lib/views/sandboxes/fakes/service";
import * as sandboxTables from "@/lib/views/sandboxes/schema";
import { createGateway } from "./gateway";
import { createCommandListener } from "./listener";
import { getLogger } from "./logger";
import { loadValidator } from "./protocol";

/**
 * Entry point. Env:
 * - DATABASE_URL: the pool (at most 5 connections) for reads and writes.
 * - SANDBOX_GATEWAY_LISTEN_URL: the direct connection that holds LISTEN; defaults
 *   to DATABASE_URL, which on RDS is already direct (no pooler).
 * - SANDBOX_GATEWAY_TOKEN_SECRET: the HMAC key shared with the web app.
 * - PORT (default 8787), GATEWAY_ID (default a random `gw_<hex>` per process),
 *   DATABASE_SSL (`disable` | `require`, defaulted from the URL like migrate).
 * - Fakes (RC-1107): the Claude backend of the web app (`ANTHROPIC_BACKEND`,
 *   `ANTHROPIC_API_KEY`), `SANDBOX_FAKE_MODEL` (default the small model),
 *   `SANDBOX_FAKE_DAILY_CAP`. The internal cap event goes through the telemetry port.
 *
 * Owned (ADR-0030): the cap event is `trackServerEvent` (the edition's telemetry port) in place
 * of the Cloud analytics client; there is no model-call label lookup to switch off here; the
 * Drizzle schema is the tables barrel plus the sandboxes fragment.
 */

const schema = { ...tables, ...sandboxTables };

const logger = getLogger("gateway");

async function main(): Promise<void> {
  const env = process.env;
  const databaseUrl = required(env.DATABASE_URL, "DATABASE_URL");
  const tokenSecret = required(env.SANDBOX_GATEWAY_TOKEN_SECRET, "SANDBOX_GATEWAY_TOKEN_SECRET");
  if (tokenSecret.length < MIN_TOKEN_SECRET_LENGTH)
    throw new Error("SANDBOX_GATEWAY_TOKEN_SECRET is too short");
  const gatewayId = env.GATEWAY_ID ?? `gw_${randomBytes(6).toString("hex")}`;
  if (!GATEWAY_ID_PATTERN.test(gatewayId)) throw new Error("GATEWAY_ID must match [a-z0-9_]{1,40}");
  const ssl = sslFor(databaseUrl, env.DATABASE_SSL);

  const pool = new pg.Pool({ connectionString: databaseUrl, ssl, max: 5 });
  pool.on("error", (err) => logger.error({ err: { message: err.message } }, "pool client failed"));
  const db = drizzle(pool, { schema }) as unknown as SandboxDb;
  const store = createPgSandboxGatewayStore(db);
  const gateway = createGateway({
    gatewayId,
    store,
    validator: loadValidator(),
    tokenSecret,
    logger,
    fakes: fakeService(db, env),
  });
  const listener = createCommandListener({
    connectionString: env.SANDBOX_GATEWAY_LISTEN_URL ?? databaseUrl,
    ssl,
    channel: gatewayChannel(gatewayId),
    onWake: () => gateway.wake(),
    logger: getLogger("gateway/listener"),
  });

  const port = await gateway.listen(Number(env.PORT ?? 8787));
  await listener.start();
  logger.info({ gateway_id: gatewayId, port }, "started gateway");

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal, connections: gateway.connectionCount() }, "draining gateway");
    await gateway.drain("gateway shutdown");
    await listener.stop();
    await gateway.close();
    await pool.end();
    logger.info({}, "stopped gateway");
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

/** The fake service on the gateway's own pool. */
function fakeService(db: SandboxDb, env: NodeJS.ProcessEnv): FakeService {
  const client = anthropicClient({ maxRetries: 1 });
  const fakeLogger = getLogger("gateway/fakes");
  if (!client)
    fakeLogger.warn({}, "started without a claude backend: generated fakes answer a tool error");
  const capture: CaptureEvent = (distinctId, event, properties) =>
    void trackServerEvent(event as ServerEventName, { distinctId }, properties);
  return createFakeService({
    store: createPgFakeStore(db),
    model: client
      ? anthropicFakeModel(client, env.SANDBOX_FAKE_MODEL || DEFAULT_FAKE_MODEL)
      : { generate: () => Promise.reject(new Error("no claude backend is configured")) },
    alerts: createFakeAlerts(fakeLogger, capture),
    dailyCap: dailyCap(env.SANDBOX_FAKE_DAILY_CAP),
    onGenerationError: (err, request) =>
      fakeLogger.error(
        {
          err: { message: (err as Error).message, name: (err as Error).name },
          run_id: request.runId,
          tool: request.tool,
        },
        "fake generation failed",
      ),
  });
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function sslFor(url: string, mode: string | undefined): false | { rejectUnauthorized: boolean } {
  const resolved = mode ?? (/localhost|127\.0\.0\.1/.test(url) ? "disable" : "require");
  return resolved === "disable" ? false : { rejectUnauthorized: false };
}

main().catch((err: Error) => {
  logger.error({ err: { message: err.message } }, "gateway failed to start");
  process.exit(1);
});
