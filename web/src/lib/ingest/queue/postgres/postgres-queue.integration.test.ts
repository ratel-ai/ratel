import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/pglite";
import { Pool } from "pg";
import type { SettledDelivery } from "@/lib/contracts/ingest-queue";
import { encodeEnvelope } from "@/lib/ingest/queue/envelope";
import { maxDeliveries, RETRY_POLICY, type RetryPolicy } from "@/lib/ingest/queue/port/settle";
import {
  envelope,
  type QueueHarness,
  runQueueConformance,
} from "@/lib/ingest/queue/port/test-support/conformance";
import { ingestSpool } from "@/lib/ingest/queue/postgres/schema";
import * as tables from "@/lib/platform/db/tables";
import { createMigratedPGlite, organizations } from "@/lib/platform/db/test-support";
import { projects } from "@/lib/platform/projects/schema";
import { createPostgresQueue } from "./postgres-queue";
import {
  claimMessage,
  deadLetterMessage,
  insertMessage,
  listDeadLetters,
  pruneDeadLetters,
  readDeadLetterFrame,
  redeliverMessage,
  removeMessage,
  type SpoolDb,
} from "./store";

const LEASE_MS = 60_000;

runQueueConformance("postgres (PGlite)", async (policy) => {
  const { db, projectIds, close } = await pgliteDb();
  return harness(db, projectIds, policy, close);
});

// PGlite is one connection, so it cannot race. `TEST_POSTGRES_URL` names an empty, migrated
// database of a real server for the cases where two processes claim at once.
const realUrl = process.env.TEST_POSTGRES_URL;
if (realUrl) {
  const pool = new Pool({ connectionString: realUrl, max: 20 });
  before(async () => {
    // The edition's table, as `createMigratedPGlite` makes it.
    await pool.query(
      "create table if not exists organizations (id uuid primary key, name text not null, slug text not null unique)",
    );
  });
  after(() => pool.end());
  const db = drizzleNode({ client: pool, schema: tables });
  runQueueConformance("postgres (server)", async (policy) => {
    await db.execute(sql`truncate ingest_spool`);
    const projectIds = await seedProjects(db);
    return harness(db, projectIds, policy, async () => undefined);
  });

  test("postgres (server): consumers that race never hold two messages of one project", async () => {
    await db.execute(sql`truncate ingest_spool`);
    const projectIds = await seedProjects(db);
    for (let index = 0; index < 40; index++) {
      for (const projectId of projectIds) await insert(db, projectId);
    }
    const inHand = new Set<string>();
    let done = 0;
    const worker = async () => {
      while (done < 40 * projectIds.length) {
        const claim = await claimMessage(db, LEASE_MS);
        if (!claim) continue;
        assert.equal(inHand.has(claim.projectId), false);
        inHand.add(claim.projectId);
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
        inHand.delete(claim.projectId);
        assert.equal(await removeMessage(db, claim), true);
        done += 1;
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    assert.equal(done, 40 * projectIds.length);
  });
}

test("a project with a message in hand is not claimed again, also for an older row", async () => {
  const { db, projectIds } = await pgliteDb();
  const [busy, free] = projectIds;
  await insert(db, busy);
  const second = await insert(db, busy);
  // The first publish commits after the second was claimed: it has the lower seq.
  const [late] = await db
    .delete(ingestSpool)
    .where(sql`${ingestSpool.messageId} <> ${second}`)
    .returning();
  const claim = await claimMessage(db, LEASE_MS);
  assert.equal(claim?.messageId, second);
  await db.execute(sql`
    insert into ingest_spool (seq, message_id, project_id, frame) overriding system value
    values (${late.seq}, ${late.messageId}, ${busy}, ${late.frame})
  `);

  assert.equal(await claimMessage(db, LEASE_MS), null);
  const other = await insert(db, free);
  assert.equal((await claimMessage(db, LEASE_MS))?.messageId, other);

  assert.ok(claim);
  assert.equal(await removeMessage(db, claim), true);
  assert.equal((await claimMessage(db, LEASE_MS))?.messageId, late.messageId);
});

test("a claim that ended is taken by another consumer, and the first changes nothing", async () => {
  const { db, projectIds } = await pgliteDb();
  const id = await insert(db, projectIds[0]);
  const lost = await claimMessage(db, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const taken = await claimMessage(db, LEASE_MS);
  assert.ok(lost && taken);
  assert.deepEqual([lost.deliveries, taken.deliveries, taken.messageId], [1, 2, id]);

  assert.equal(await removeMessage(db, lost), false);
  assert.equal(
    await redeliverMessage(db, lost, { waitMs: 0, outage: false, reason: "late" }),
    false,
  );
  assert.equal(await deadLetterMessage(db, lost, "late", 1), false);
  assert.equal(await removeMessage(db, taken), true);
});

test("a message whose deliveries end without a result becomes a dead letter", async () => {
  const { db, projectIds } = await pgliteDb();
  const id = await insert(db, projectIds[0]);
  for (let index = 0; index < maxDeliveries(RETRY_POLICY); index++) {
    assert.ok(await claimMessage(db, 1));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const settled: SettledDelivery[] = [];
  let deliveries = 0;
  const consumer = createPostgresQueue({ db, pollMs: 5 }).consume(
    async () => {
      deliveries += 1;
      return { outcome: "ack" };
    },
    { onSettled: (delivery) => settled.push(delivery) },
  );
  while (settled.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await consumer.stop();
  assert.equal(deliveries, 0);
  assert.deepEqual(settled[0], {
    messageId: id,
    projectId: projectIds[0],
    attempt: 5,
    outcome: "dead-letter",
    reason: "the last delivery ended without a result",
  });
  assert.equal((await listDeadLetters(db))[0].deliveries, 5);
});

test("a claim is renewed while the handler runs", async () => {
  const { db, projectIds } = await pgliteDb();
  await insert(db, projectIds[0]);
  let deliveries = 0;
  const queue = createPostgresQueue({ db, pollMs: 5, leaseMs: 150 });
  const options = [queue, createPostgresQueue({ db, pollMs: 5, leaseMs: 150 })].map((each) =>
    each.consume(async () => {
      deliveries += 1;
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { outcome: "ack" };
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 900));
  await Promise.all(options.map((consumer) => consumer.stop()));
  assert.equal(deliveries, 1);
  assert.equal((await db.select().from(ingestSpool)).length, 0);
});

test("dead letters are listed per project and deleted after 14 days or with the project", async () => {
  const { db, projectIds } = await pgliteDb();
  const [first, second] = projectIds;
  for (const projectId of [first, second, first]) {
    await insert(db, projectId);
    const claim = await claimMessage(db, LEASE_MS);
    assert.ok(claim);
    await deadLetterMessage(db, claim, `bad body of ${claim.seq}`, claim.deliveries);
  }
  await insert(db, first);

  const all = await listDeadLetters(db);
  assert.deepEqual(
    all.map(({ projectId, reason, deliveries }) => [projectId, reason, deliveries]),
    [
      [first, "bad body of 3", 1],
      [second, "bad body of 2", 1],
      [first, "bad body of 1", 1],
    ],
  );
  assert.deepEqual(
    (await listDeadLetters(db, { projectId: first, limit: 1 })).map(({ seq }) => seq),
    [3],
  );
  assert.ok(all[0].lastFailedAt >= all[0].firstFailedAt);
  assert.equal(await readDeadLetterFrame(db, 4), null, "a queued message is not a dead letter");
  assert.ok(await readDeadLetterFrame(db, 3));

  await db
    .update(ingestSpool)
    .set({ deadAt: new Date(Date.now() - 15 * 86_400_000) })
    .where(eq(ingestSpool.seq, 1));
  assert.equal(await pruneDeadLetters(db), 1);
  assert.equal(await pruneDeadLetters(db), 0);

  await db.delete(projects).where(eq(projects.id, first));
  assert.deepEqual(
    (await db.select({ seq: ingestSpool.seq }).from(ingestSpool).orderBy(asc(ingestSpool.seq))).map(
      ({ seq }) => seq,
    ),
    [2],
  );
});

test("a failed publish rejects without the message's content", async () => {
  const { db } = await pgliteDb();
  const message = envelope(randomUUID());
  await assert.rejects(createPostgresQueue({ db }).publish(message), (error: Error) => {
    assert.equal(error.message, "ingest spool insert failed");
    assert.equal((error as { code?: string }).code, "23503");
    assert.equal(error.cause, undefined);
    return true;
  });
});

async function insert(db: SpoolDb, projectId: string): Promise<string> {
  const message = envelope(projectId);
  await insertMessage(db, {
    messageId: message.id,
    projectId,
    frame: encodeEnvelope(message),
  });
  return message.id;
}

function harness(
  db: SpoolDb,
  projectIds: string[],
  policy: RetryPolicy,
  close: () => Promise<void>,
): QueueHarness {
  return {
    open: async () => createPostgresQueue({ db, policy, pollMs: 5 }),
    publishFrame: (projectId, frame) =>
      insertMessage(db, { messageId: randomUUID(), projectId, frame }),
    projectIds,
    deadLetters: async () =>
      Promise.all(
        (await listDeadLetters(db)).map(async (letter) => ({
          ...letter,
          id: letter.messageId,
          frame: (await readDeadLetterFrame(db, letter.seq)) ?? new Uint8Array(),
        })),
      ),
    close,
  };
}

async function pgliteDb(): Promise<{
  db: SpoolDb;
  projectIds: string[];
  close: () => Promise<void>;
}> {
  const client = await createMigratedPGlite();
  const db = drizzle({ client, schema: tables }) as unknown as SpoolDb;
  return { db, projectIds: await seedProjects(db), close: () => client.close() };
}

async function seedProjects(db: SpoolDb): Promise<string[]> {
  const organizationId = randomUUID();
  await db
    .insert(organizations)
    .values({ id: organizationId, name: "Acme", slug: organizationId })
    .onConflictDoNothing();
  const rows = await db
    .insert(projects)
    .values(
      ["one", "two", "three"].map((name) => ({
        name,
        slug: `${name}-${organizationId}`,
        organizationId,
      })),
    )
    .returning({ id: projects.id });
  return rows.map(({ id }) => id);
}
