import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { WebSocket } from "ws";
import * as tables from "@/lib/platform/db/tables";
import type { SandboxDb } from "@/lib/views/sandboxes/adapters/pg-store";
import { signSandboxToken } from "@/lib/views/sandboxes/domain/token";
import * as sandboxTables from "@/lib/views/sandboxes/schema";
import { type Envelope, loadValidator } from "../src/protocol";

/**
 * Real-Postgres test support. `TEST_DATABASE_URL` points at a server where the
 * user may create databases (locally: `make dev`'s Postgres). Each test file
 * gets its own fresh database, migrated with the web app's migrations.
 *
 * Owned (ADR-0030): the migrations are the core's folder (src/lib/platform/db/migrations); the
 * schema is the tables barrel plus the sandboxes fragment; the edition's identity module owns
 * `organizations`, so the fixture makes a minimal one, as the core's PGlite test support does.
 */

const schema = { ...tables, ...sandboxTables };

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const SECRET = "g".repeat(48);
export const ORG = "22222222-2222-4222-8222-222222222222";
export const PROJECT = "11111111-1111-4111-8111-111111111111";
export const OWNER = "user_owner";

const validator = loadValidator();

export interface TestDatabase {
  url: string;
  pool: pg.Pool;
  db: SandboxDb;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = new URL(TEST_DATABASE_URL!);
  const name = `gw_test_${randomBytes(4).toString("hex")}`;
  await withClient(admin.href, (c) => c.query(`create database ${name}`));
  const url = new URL(admin.href);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.href, max: 5 });
  const db = drizzle(pool, { schema });
  await migrate(db, {
    migrationsFolder: join(process.cwd(), "../../src/lib/platform/db/migrations"),
  });
  await pool.query(`
    create table if not exists organizations (id uuid primary key, name text not null, slug text not null unique);
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a');
  `);
  return {
    url: url.href,
    pool,
    db: db as unknown as SandboxDb,
    async drop() {
      await pool.end();
      await withClient(admin.href, (c) => c.query(`drop database if exists ${name} with (force)`));
    },
  };
}

export function tokenFor(claims: Partial<{ projectId: string; ownerUserId: string }> = {}): string {
  return signSandboxToken(
    {
      projectId: claims.projectId ?? PROJECT,
      organizationId: ORG,
      ownerUserId: claims.ownerUserId ?? OWNER,
      apiKeyId: "k1",
    },
    SECRET,
    new Date(),
  ).token;
}

/** A scripted sandbox/v1 worker that checks every frame it gets against the schemas. */
export class TestWorker {
  readonly frames: Envelope[] = [];
  readonly invalid: string[] = [];
  closeCode: number | null = null;
  private readonly ws: WebSocket;
  private readonly opened: Promise<void>;
  private readonly waiters: { match: (f: Envelope) => boolean; resolve: (f: Envelope) => void }[] =
    [];
  private sent = 0;

  constructor(port: number, token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/runner?token=${encodeURIComponent(token)}`);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Envelope;
      const invalid = validator.message(frame);
      if (invalid) this.invalid.push(`${frame.type}: ${invalid}`);
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) {
        if (!waiter.match(frame)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    });
    this.ws.on("close", (code) => (this.closeCode = code));
  }

  static async connect(
    port: number,
    token = tokenFor(),
    instanceId = "rnr_test",
  ): Promise<TestWorker> {
    const worker = new TestWorker(port, token);
    await worker.opened;
    worker.send("register", {
      runner: { instanceId, owner: "dev@example.com", host: "test.local" },
      capabilities: [],
      maxConcurrency: 2,
      manifest: MANIFEST,
    });
    await worker.waitFor((f) => f.type === "registered");
    return worker;
  }

  send(type: string, payload: Record<string, unknown>, runId?: string, seq?: number): void {
    const frame = {
      v: 1,
      type,
      id: `w_${++this.sent}`,
      ts: new Date().toISOString(),
      ...(runId ? { runId } : {}),
      ...(seq ? { seq } : {}),
      payload,
    };
    this.ws.send(JSON.stringify(frame));
  }

  event(runId: string, seq: number, text = `t${seq}`): void {
    this.send("run.event", { kind: "text.delta", text }, runId, seq);
  }

  waitFor(match: (f: Envelope) => boolean, timeoutMs = 5_000): Promise<Envelope> {
    const seen = this.frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no matching frame in ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.waiters.push({ match, resolve: (f) => (clearTimeout(timer), resolve(f)) });
    });
  }

  waitClosed(timeoutMs = 5_000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not close")), timeoutMs);
      this.ws.once("close", (code) => (clearTimeout(timer), resolve(code)));
    });
  }

  terminate(): void {
    this.ws.terminate();
  }
}

export const MANIFEST = {
  sdk: { language: "typescript", name: "@ratel-ai/sandbox", version: "0.1.0" },
  build: { id: "3f9a1c2e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a", dirty: false },
  providers: [{ provider: "anthropic", keys: ["ANTHROPIC_API_KEY"] }],
  sandboxes: [
    {
      id: "workflow-label",
      file: "apps/web/lib/trace-signals/workflows/label.sandbox.ts",
      modelResolver: "builtin",
      input: { kind: "structured", schema: { type: "object" } },
      params: [
        { name: "maxTokens", kind: "scalar", type: "int", default: 400, min: 50, max: 2000 },
      ],
      context: [],
    },
  ],
};

export async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not met in time");
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
