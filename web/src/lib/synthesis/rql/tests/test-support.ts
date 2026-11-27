import type { PGlite, Transaction } from "@electric-sql/pglite";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { RqlPool } from "../adapters/pg-executor";

/** What the RQL tests share: a database the runner can use, with the migrations of the app. */

/** A pool over one PGlite. PGlite has one connection, so a client waits for the one before it. */
export async function pglitePool(): Promise<RqlPool & { end(): Promise<void> }> {
  return pglitePoolOf(await createMigratedPGlite());
}

/**
 * A pool over a PGlite that another fixture made and seeded. PGlite has one session: a
 * transaction of the runner (`begin read only` to `rollback`) runs as a PGlite transaction, so the
 * fixture's own reads of the same PGlite wait for it to end, as they would on another connection
 * of Postgres, and never run inside it as the role `ratel_rql`.
 */
export function pglitePoolOf(db: PGlite): RqlPool & { end(): Promise<void> } {
  let queue: Promise<void> = Promise.resolve();
  return {
    async connect() {
      let release: () => void = () => {};
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      const before = queue;
      queue = before.then(() => mine);
      await before;
      let open: { tx: Transaction; end: () => void; done: Promise<void> } | null = null;
      return {
        async query({ text, values, rowMode }) {
          const options = rowMode ? { rowMode } : {};
          const begin = /^begin( read only)?$/i.exec(text.trim());
          if (begin && !open) {
            open = await transaction(db, Boolean(begin[1]));
            return { rows: [] };
          }
          if (/^(rollback|commit)$/i.test(text.trim()) && open) {
            const { tx, end, done } = open;
            open = null;
            if (!tx.closed) await tx.rollback();
            end();
            await done;
            return { rows: [] };
          }
          const result = await (open?.tx ?? db).query(text, values ?? [], options);
          return { rows: result.rows as unknown[] };
        },
        release: () => release(),
      };
    },
    end: () => db.close(),
  };
}

/** A PGlite transaction held open until `end`: it holds the PGlite's lock until then. */
async function transaction(
  db: PGlite,
  readOnly: boolean,
): Promise<{ tx: Transaction; end: () => void; done: Promise<void> }> {
  let end: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  let ready: (tx: Transaction) => void = () => {};
  const started = new Promise<Transaction>((resolve) => {
    ready = resolve;
  });
  const done = db
    .transaction(async (tx) => {
      if (readOnly) await tx.query("set transaction read only");
      ready(tx);
      await ended;
    })
    // A transaction that failed is rolled back: the runner already read its error.
    .then(
      () => {},
      () => {},
    );
  return { tx: await started, end, done };
}
