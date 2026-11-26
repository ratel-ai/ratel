import { requestRead } from "@/lib/contracts/request-read";
import { isDbConfigured } from "@/lib/platform/db/client";

export interface DbConfiguredDeps {
  connection: () => Promise<void>;
  isDbConfigured: () => boolean;
}

const defaultDeps: DbConfiguredDeps = { connection: requestRead, isDbConfigured };

/**
 * `isDbConfigured()` for pages, layouts and the helpers they render with. It waits for a request
 * first: under Cache Components a render path is prerendered at build up to its first request
 * read, and the image is built without `DATABASE_URL`, so a bare check would bake "no database"
 * (a 404, a setup notice, a skipped gate) into every deployment of it. A self-hoster sets the
 * database on the running image. The wait is `requestRead()`, which resolves at once outside Next.
 *
 * Kept apart from `db/client.ts` so the scripts and the worker that import the client never pull
 * in Next. Biome keeps the bare gate out of `app/` and `components/` (`biome.json`).
 */
export async function dbConfigured(deps: DbConfiguredDeps = defaultDeps): Promise<boolean> {
  await deps.connection();
  return deps.isDbConfigured();
}
