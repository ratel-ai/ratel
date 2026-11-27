import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

/**
 * The projects on hold, as a subquery of ids. Uncorrelated, so Postgres reads it once per
 * statement; with no hold it is one read of an empty table.
 */
export const HELD_PROJECT_IDS: SQL = sql`(
  select h.project_id from org_holds h where h.project_id is not null
  union all
  select p.id from projects p join org_holds h on h.organization_id = p.organization_id
)`;

/** True for a row whose project is not on hold. For a background read or write over every project. */
export function notOnHold(projectId: SQLWrapper): SQL {
  return sql`${projectId} not in ${HELD_PROJECT_IDS}`;
}
