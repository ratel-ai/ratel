import assert from "node:assert/strict";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { after, test } from "node:test";
import { Pool } from "pg";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
  hardenPoolClients,
  poolConfig,
} from "@/lib/platform/db/pool";

test("poolConfig sets timeouts and keepalive by default", () => {
  const config = poolConfig("postgres://db/app", false, {});
  assert.equal(config.max, 10);
  assert.equal(config.connectionTimeoutMillis, DEFAULT_CONNECT_TIMEOUT_MS);
  assert.equal(config.query_timeout, DEFAULT_QUERY_TIMEOUT_MS);
  assert.equal(
    config.statement_timeout,
    DEFAULT_QUERY_TIMEOUT_MS - 5_000,
    "Postgres cancels first",
  );
  assert.equal(config.keepAlive, true);
});

test("poolConfig leaves the server limit unset when the client timeout is off", () => {
  const config = poolConfig("postgres://db/app", false, { DATABASE_QUERY_TIMEOUT_MS: "0" });
  assert.equal(config.query_timeout, 0);
  assert.equal(config.statement_timeout, undefined);
});

test("poolConfig reads env overrides, 0 turns a timeout off, typos keep the default", () => {
  const config = poolConfig("postgres://db/app", false, {
    DATABASE_POOL_MAX: "4",
    DATABASE_CONNECT_TIMEOUT_MS: "0",
    DATABASE_QUERY_TIMEOUT_MS: "30s",
  });
  assert.equal(config.max, 4);
  assert.equal(config.connectionTimeoutMillis, 0);
  assert.equal(config.query_timeout, DEFAULT_QUERY_TIMEOUT_MS);
});

/**
 * Just enough of the Postgres wire protocol for pg: trust auth on startup, and
 * an empty answer to each query. A connection in `silent` goes quiet after
 * startup, like a socket whose server restarted underneath it.
 */
function fakePostgres(silent: (connection: number) => boolean): {
  server: Server;
  sockets: Socket[];
} {
  const sockets: Socket[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    const connection = ++connections;
    let started = false;
    let buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 4) return;
          const length = buffer.readInt32BE(0);
          if (buffer.length < length) return;
          buffer = buffer.subarray(length);
          started = true;
          socket.write(Buffer.concat([message("R", int32(0)), message("Z", Buffer.from("I"))]));
          continue;
        }
        if (buffer.length < 5) return;
        const type = String.fromCharCode(buffer[0]);
        const length = buffer.readInt32BE(1);
        if (buffer.length < length + 1) return;
        buffer = buffer.subarray(length + 1);
        if (type === "Q" && !silent(connection)) {
          socket.write(
            Buffer.concat([message("I", Buffer.alloc(0)), message("Z", Buffer.from("I"))]),
          );
        }
      }
    });
  });
  return { server, sockets };
}

function message(type: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `postgres://ratel@127.0.0.1:${(server.address() as AddressInfo).port}/app`;
}

test("a connection that stops answering is dropped and the pool keeps serving", async () => {
  const { server, sockets } = fakePostgres((connection) => connection === 1);
  const url = await listen(server);
  const warnings: string[] = [];
  const pool = new Pool({
    ...poolConfig(url, false, { DATABASE_QUERY_TIMEOUT_MS: "200" }),
    max: 1,
  });
  hardenPoolClients(pool, { logWarn: (message) => warnings.push(message) });
  after(async () => {
    await pool.end();
    for (const socket of sockets) socket.destroy();
    server.close();
  });

  // A checked-out client, the way a Drizzle transaction holds one.
  const stuck = await pool.connect();
  await assert.rejects(stuck.query("select 1"), /Query read timeout/);
  // Without the fix this second query queues behind the stuck one forever.
  await assert.rejects(stuck.query("rollback"), /not queryable|Connection terminated/);
  stuck.release();

  assert.equal(pool.totalCount, 0, "the stuck client left the pool");
  await pool.query("select 1");
  assert.deepEqual(warnings.slice(0, 1), ["query read timeout, dropping the connection"]);
});

test("waiting for a connection gives up instead of hanging", async () => {
  // Accepts the socket but never finishes startup: a database that is not answering.
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
  });
  const url = await listen(server);
  const pool = new Pool(poolConfig(url, false, { DATABASE_CONNECT_TIMEOUT_MS: "200" }));
  hardenPoolClients(pool, { logWarn: () => {} });
  after(async () => {
    await pool.end();
    for (const socket of sockets) socket.destroy();
    server.close();
  });

  await assert.rejects(pool.query("select 1"), /timeout/i);
});
