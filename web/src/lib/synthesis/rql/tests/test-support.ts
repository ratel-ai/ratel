import type { PGlite } from "@electric-sql/pglite";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { RqlPool } from "../adapters/pg-executor";

/** What the RQL tests share: a database the runner can use, with the migrations of the app. */

/** A pool over one PGlite. PGlite has one connection, so a client waits for the one before it. */
export async function pglitePool(): Promise<RqlPool & { end(): Promise<void> }> {
  const db: PGlite = await createMigratedPGlite();
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
      return {
        async query({ text, values, rowMode }) {
          const result = await db.query(text, values ?? [], rowMode ? { rowMode } : {});
          return { rows: result.rows as unknown[] };
        },
        release: () => release(),
      };
    },
    end: () => db.close(),
  };
}
