import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

// Support tickets in a local SQLite file: the side effect of the docs agent.
// node:sqlite loads on the first ticket call only, so a run that never writes
// a ticket (a sandbox run with createTicket faked) never opens the file.

export interface Ticket {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly email: string | null;
  readonly createdAt: string;
}

export const DEFAULT_TICKETS_DB = ".data/tickets.sqlite";

export function ticketsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TICKETS_DB ?? DEFAULT_TICKETS_DB;
}

export async function createTicket(
  ticket: { title: string; body: string; email?: string },
  path = ticketsPath(),
): Promise<Ticket> {
  const db = await open(path);
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

export async function listTickets(path = ticketsPath()): Promise<Ticket[]> {
  const db = await open(path);
  try {
    return db
      .prepare("SELECT id, title, body, email, created_at AS createdAt FROM tickets ORDER BY id")
      .all() as unknown as Ticket[];
  } finally {
    db.close();
  }
}

async function open(path: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL)",
  );
  return db;
}
