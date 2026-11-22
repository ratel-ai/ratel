import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest } from "@ratel-ai/sandbox";
import { afterAll, describe, expect, it } from "vitest";
import docsSandbox from "../docs-agent.sandbox.js";
import { createTicket, describeStore, listTickets, ticketStore } from "../src/tickets.js";

// Where tickets go: SQLite locally, the Postgres sidecar when DATABASE_URL is set.
// The Postgres round trip runs only with TICKETS_TEST_DATABASE_URL (a disposable database).

const TEST_DATABASE_URL = process.env.TICKETS_TEST_DATABASE_URL;
const dir = mkdtempSync(join(tmpdir(), "docs-agent-tickets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ticketStore", () => {
  it("is the SQLite file by default and Postgres when DATABASE_URL is set", () => {
    expect(ticketStore({})).toEqual({ kind: "sqlite", path: ".data/tickets.sqlite" });
    expect(ticketStore({ TICKETS_DB: "x.sqlite" })).toEqual({ kind: "sqlite", path: "x.sqlite" });
    expect(ticketStore({ DATABASE_URL: "postgres://u:pw@db:5432/app" })).toEqual({
      kind: "postgres",
      url: "postgres://u:pw@db:5432/app",
    });
  });

  it("never names the database URL in its description", () => {
    const store = ticketStore({ DATABASE_URL: "postgres://u:pw@db:5432/app" });
    expect(describeStore(store)).toBe("Postgres (DATABASE_URL)");
  });
});

describe("SQLite store (the local default)", () => {
  it("writes and lists a ticket", async () => {
    const path = join(dir, "tickets.sqlite");
    await createTicket({ title: "401", body: "traces fail" }, { kind: "sqlite", path });
    expect(await listTickets(path)).toMatchObject([{ id: 1, title: "401", email: null }]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Postgres store (the hosted sidecar)", () => {
  it("writes and lists a ticket in the table of db/seed.sql", async () => {
    const store = { kind: "postgres", url: TEST_DATABASE_URL as string } as const;
    const ticket = await createTicket({ title: "401", body: "traces fail", email: "a@b.c" }, store);
    expect(ticket).toMatchObject({ title: "401", email: "a@b.c" });
    expect(await listTickets(store)).toContainEqual(ticket);
  });
});

describe("the sandbox image", () => {
  it("declares a Postgres sidecar seeded with the tickets table", () => {
    const [entry] = buildManifest({ sandboxes: [{ sandbox: docsSandbox }] }).sandboxes;
    expect(entry?.image).toMatchObject({
      base: "node:22-slim",
      sidecars: [{ kind: "postgres", seed: "db/seed.sql" }],
    });
    expect(entry?.state).toBe("run");
    const seed = readFileSync(new URL("../db/seed.sql", import.meta.url), "utf8");
    expect(seed).toMatch(/CREATE TABLE IF NOT EXISTS tickets/);
  });
});
