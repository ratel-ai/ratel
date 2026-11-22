import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Client } from "pg";

// Support tickets: the side effect of the docs agent. Locally they go to a
// SQLite file. In a hosted sandbox the image starts a Postgres sidecar and sets
// DATABASE_URL, so they go there. The driver loads on the first ticket call
// only, so a run that never writes a ticket (createTicket faked) opens nothing.

export interface Ticket {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly email: string | null;
  readonly createdAt: string;
}

/** Where tickets go: a Postgres database, or a SQLite file. */
export type TicketStore =
  | { readonly kind: "postgres"; readonly url: string }
  | { readonly kind: "sqlite"; readonly path: string };

type NewTicket = { title: string; body: string; email?: string };

export const DEFAULT_TICKETS_DB = ".data/tickets.sqlite";

/** The tickets table, the same as db/seed.sql of the Postgres sidecar. */
const POSTGRES_TABLE =
  "CREATE TABLE IF NOT EXISTS tickets (id SERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, email TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())";

/** Postgres when DATABASE_URL is set (the hosted sidecar), else the SQLite file. */
export function ticketStore(env: NodeJS.ProcessEnv = process.env): TicketStore {
  return env.DATABASE_URL
    ? { kind: "postgres", url: env.DATABASE_URL }
    : { kind: "sqlite", path: ticketsPath(env) };
}

export function ticketsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TICKETS_DB ?? DEFAULT_TICKETS_DB;
}

/** Where the tickets go, for a log line. Never the database URL: it can hold a password. */
export function describeStore(store: TicketStore = ticketStore()): string {
  return store.kind === "postgres" ? "Postgres (DATABASE_URL)" : store.path;
}

/** Writes one ticket. A string is the path of a SQLite file. */
export async function createTicket(
  ticket: NewTicket,
  store: TicketStore | string = ticketStore(),
): Promise<Ticket> {
  const target = asStore(store);
  return target.kind === "postgres"
    ? createInPostgres(ticket, target.url)
    : createInSqlite(ticket, target.path);
}

/** Every ticket, oldest first. A string is the path of a SQLite file. */
export async function listTickets(store: TicketStore | string = ticketStore()): Promise<Ticket[]> {
  const target = asStore(store);
  if (target.kind === "postgres") {
    return withPostgres(target.url, async (client) => {
      const { rows } = await client.query<Omit<Ticket, "createdAt"> & { createdAt: Date }>(
        'SELECT id, title, body, email, created_at AS "createdAt" FROM tickets ORDER BY id',
      );
      return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    });
  }
  const db = await openSqlite(target.path);
  try {
    return db
      .prepare("SELECT id, title, body, email, created_at AS createdAt FROM tickets ORDER BY id")
      .all() as unknown as Ticket[];
  } finally {
    db.close();
  }
}

function asStore(store: TicketStore | string): TicketStore {
  return typeof store === "string" ? { kind: "sqlite", path: store } : store;
}

async function createInPostgres(ticket: NewTicket, url: string): Promise<Ticket> {
  return withPostgres(url, async (client) => {
    const { rows } = await client.query<{ id: number; created_at: Date }>(
      "INSERT INTO tickets (title, body, email) VALUES ($1, $2, $3) RETURNING id, created_at",
      [ticket.title, ticket.body, ticket.email ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error("the ticket insert returned no row");
    return {
      id: row.id,
      title: ticket.title,
      body: ticket.body,
      email: ticket.email ?? null,
      createdAt: row.created_at.toISOString(),
    };
  });
}

async function createInSqlite(ticket: NewTicket, path: string): Promise<Ticket> {
  const db = await openSqlite(path);
  try {
    const createdAt = new Date().toISOString();
    const result = db
      .prepare("INSERT INTO tickets (title, body, email, created_at) VALUES (?, ?, ?, ?)")
      .run(ticket.title, ticket.body, ticket.email ?? null, createdAt);
    return {
      id: Number(result.lastInsertRowid),
      title: ticket.title,
      body: ticket.body,
      email: ticket.email ?? null,
      createdAt,
    };
  } finally {
    db.close();
  }
}

async function withPostgres<T>(url: string, use: (client: Client) => Promise<T>): Promise<T> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(POSTGRES_TABLE);
    return await use(client);
  } finally {
    await client.end();
  }
}

async function openSqlite(path: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL)",
  );
  return db;
}
