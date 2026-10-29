import { and, asc, desc, eq, getTableColumns, isNull, ne, or, sql } from "drizzle-orm";
import { type NewSkill, type Skill, skills } from "@/lib/catalog/schema";
import type { WireSkill } from "@/lib/catalog/wire";
import { etagOf } from "@/lib/catalog/wire";
import type { WireSkill as WireSkillV2 } from "@/lib/catalog/wire-v2";
import { etagOf as etagOfV2 } from "@/lib/catalog/wire-v2";
import { getDb } from "@/lib/platform/db/client";
import { isUniqueViolation } from "@/lib/platform/db/errors";
import { projects } from "@/lib/platform/projects/schema";

/** The skills catalog reads and writes (owned fragment of the upstream queries hub, ADR-0030). */

type SkillStatus = Skill["status"];

/* — Skills catalog ——————————————————————————————————————————————————————————

   The durable, per-project skill catalog + its sync ETag. CRUD (create/edit/
   publish/archive) is called by the account-authed dashboard or a dev import;
   the read side (`getPublishedCatalog` + the stored `catalog_version`) backs the
   Bearer-authed `/v1/catalog` pull-sync. Every helper takes an optional `db` so
   the pglite integration test exercises the real functions; production passes
   nothing and gets the Neon client. */

/** The subset of the Drizzle client the catalog helpers use — lets a test inject pglite. */
export type SkillsDb = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update">;

/** A create/edit/publish/archive outcome — success carries the new row; failure
 * says why so the HTTP layer can map it to 404 / 409. */
export type SkillMutationResult =
  | { ok: true; skill: Skill }
  | { ok: false; reason: "not_found" | "version_conflict" | "name_conflict" };

/** The fields an edit may change (DB column names — the `tools` column carries
 * the wire field directly). `endUserId` re-scopes the skill: a string scopes it
 * to that end-user, null clears the scope back to global — on a published skill
 * either direction changes sync-catalog membership, which is safe because
 * updateSkill recomputes the catalog version whenever the edited row is
 * published. */
export type SkillEditPatch = {
  name?: string;
  description?: string;
  searchableDescription?: string | null;
  body?: string;
  tags?: string[];
  tools?: string[];
  metadata?: Record<string, string[]>;
  endUserId?: string | null;
};

/** A catalog row → the protocol/v1 sync wire object. `name` doubles as the
 * stable wire `id` (unique per project among non-archived rows); the stored
 * UUID never crosses the wire. Exported for `/api/v1/catalog`, which maps scoped
 * rows one at a time rather than through the published-set batch below. */
export function toCatalogWire(row: {
  name: string;
  description: string;
  tags: string[];
  tools: string[];
  metadata: Record<string, string[]>;
  body: string;
}): WireSkill {
  return {
    id: row.name,
    name: row.name,
    description: row.description,
    tags: row.tags,
    tools: row.tools,
    metadata: row.metadata,
    body: row.body,
  };
}

/** A catalog row → protocol/v2, with the unset override represented as null. */
export function toCatalogWireV2(row: {
  name: string;
  description: string;
  searchableDescription: string | null;
  tags: string[];
  tools: string[];
  metadata: Record<string, string[]>;
  body: string;
}): WireSkillV2 {
  return {
    id: row.name,
    name: row.name,
    description: row.description,
    searchableDescription: row.searchableDescription,
    tags: row.tags,
    tools: row.tools,
    metadata: row.metadata,
    body: row.body,
  };
}

/**
 * The project's *published, GLOBAL* skills in sync-wire shape, ordered by name.
 * User-scoped skills (`end_user_id` set) are deliberately excluded: the sync
 * endpoint authenticates by project API key and has no end-user identity, so the
 * runtime catalog — and the stored ETag computed from this set — stays global-only
 * until the SDK can identify its end-user.
 */
export async function getPublishedCatalog(
  projectId: string,
  db: SkillsDb = getDb(),
): Promise<WireSkill[]> {
  const rows = await db
    .select({
      name: skills.name,
      description: skills.description,
      tags: skills.tags,
      tools: skills.tools,
      metadata: skills.metadata,
      body: skills.body,
    })
    .from(skills)
    .where(
      and(
        eq(skills.projectId, projectId),
        eq(skills.status, "published"),
        isNull(skills.endUserId),
      ),
    )
    .orderBy(asc(skills.name));
  return rows.map(toCatalogWire);
}

/** The project's published global catalog under the protocol/v2 projection. */
export async function getPublishedCatalogV2(
  projectId: string,
  db: SkillsDb = getDb(),
): Promise<WireSkillV2[]> {
  const rows = await db
    .select({
      name: skills.name,
      description: skills.description,
      searchableDescription: skills.searchableDescription,
      tags: skills.tags,
      tools: skills.tools,
      metadata: skills.metadata,
      body: skills.body,
    })
    .from(skills)
    .where(
      and(
        eq(skills.projectId, projectId),
        eq(skills.status, "published"),
        isNull(skills.endUserId),
      ),
    )
    .orderBy(asc(skills.name));
  return rows.map(toCatalogWireV2);
}

/**
 * The published skill ROWS visible to one end-user scope: global rows plus (when
 * `endUserId` is set) that user's own rows, ordered by name. `null` scope = global
 * only.
 */
export async function listPublishedSkillRowsForScope(
  projectId: string,
  endUserId: string | null,
  db: SkillsDb = getDb(),
): Promise<Skill[]> {
  return db
    .select()
    .from(skills)
    .where(
      and(
        eq(skills.projectId, projectId),
        eq(skills.status, "published"),
        endUserId === null
          ? isNull(skills.endUserId)
          : or(isNull(skills.endUserId), eq(skills.endUserId, endUserId)),
      ),
    )
    .orderBy(asc(skills.name));
}

/** The stored catalog ETag hex (`projects.catalog_version`); null before first publish. */
export async function getProjectCatalogVersion(
  projectId: string,
  db: SkillsDb = getDb(),
): Promise<string | null> {
  const [row] = await db
    .select({ catalogVersion: projects.catalogVersion })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.catalogVersion ?? null;
}

/** The stored protocol/v2 global catalog ETag hex. */
export async function getProjectCatalogVersionV2(
  projectId: string,
  db: SkillsDb = getDb(),
): Promise<string | null> {
  const [row] = await db
    .select({ catalogVersionV2: projects.catalogVersionV2 })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.catalogVersionV2 ?? null;
}

/**
 * Overwrite the stored catalog ETag. Also the sync endpoint's **self-heal** hook:
 * because `recomputeCatalogVersion` is a non-atomic read-then-write (the neon-http
 * driver has no interactive transactions), two concurrent set-changing mutations can
 * race and leave `catalog_version` stale. The sync 200 path — which hashes the set it
 * actually served — calls this whenever that authoritative hash differs from the
 * stored one, so any full read (a cache miss by any consumer) converges the stored
 * value back to correct. See {@link recomputeCatalogVersion}.
 */
export async function setProjectCatalogVersion(
  projectId: string,
  version: string,
  db: SkillsDb = getDb(),
): Promise<void> {
  await db.update(projects).set({ catalogVersion: version }).where(eq(projects.id, projectId));
}

/** Persist the protocol/v2 global catalog ETag hex. */
export async function setProjectCatalogVersionV2(
  projectId: string,
  version: string,
  db: SkillsDb = getDb(),
): Promise<void> {
  await db.update(projects).set({ catalogVersionV2: version }).where(eq(projects.id, projectId));
}

/**
 * Recompute the project's catalog ETag from its current published set and store it
 * on `projects.catalog_version`. Called as the final step of every mutation that can
 * change the published set (publish, archive/unpublish of a published skill, or an
 * edit to a published skill), so the sync endpoint's 304 fast-path stays correct.
 * Returns the new ETag hex (protocol/v1 `etagOf` — the same algorithm the route
 * serves, so the stored value and a freshly computed one can never disagree on
 * identical content).
 *
 * This read-then-write is not atomic (neon-http has no interactive transaction), so
 * two concurrent set-changing mutations on the same project can race and leave the
 * stored value stale. The sync 200 path is the safety net — it serves the freshly
 * hashed set and self-heals the stored value on any mismatch (see
 * {@link setProjectCatalogVersion}) — so the drift converges on the next full read
 * rather than persisting.
 */
export async function recomputeCatalogVersion(
  projectId: string,
  db: SkillsDb = getDb(),
): Promise<string> {
  const published = await getPublishedCatalog(projectId, db);
  const { hex } = etagOf(published);
  const publishedV2 = await getPublishedCatalogV2(projectId, db);
  const { hex: hexV2 } = etagOfV2(publishedV2);
  await Promise.all([
    setProjectCatalogVersion(projectId, hex, db),
    setProjectCatalogVersionV2(projectId, hexV2, db),
  ]);
  return hex;
}

/**
 * Insert one skill. Recomputes the catalog version when the row is created directly
 * as `published` (a draft insert leaves the published set untouched). Throws on a
 * duplicate active name — the CRUD create route maps that to 409.
 */
export async function insertSkill(input: NewSkill, db: SkillsDb = getDb()): Promise<Skill> {
  const [row] = await db.insert(skills).values(input).returning();
  if (row.status === "published") await recomputeCatalogVersion(row.projectId, db);
  return row;
}

/**
 * How many live (non-archived) catalog items a project has — the count the
 * per-plan `maxSkillsPerProject` limit is enforced against. Archived rows are
 * soft-deleted, so they don't count toward the cap.
 */
export async function countSkills(projectId: string, db: SkillsDb = getDb()): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(skills)
    .where(and(eq(skills.projectId, projectId), sql`${skills.status} <> 'archived'`));
  return row?.n ?? 0;
}

/**
 * Create a skill for the human CRUD path, turning a duplicate active name into a
 * `name_conflict` result the route maps to 409 (rather than throwing — a dev picked
 * this name, so they get told it's taken instead of a 500).
 */
export async function createSkill(
  input: NewSkill,
  db: SkillsDb = getDb(),
): Promise<{ ok: true; skill: Skill } | { ok: false; reason: "name_conflict" }> {
  try {
    return { ok: true, skill: await insertSkill(input, db) };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "name_conflict" };
    throw err;
  }
}

/** One skill by id, scoped to its project (ownership check). */
export async function getSkillById(
  projectId: string,
  id: string,
  db: SkillsDb = getDb(),
): Promise<Skill | null> {
  const [row] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.projectId, projectId), eq(skills.id, id)))
    .limit(1);
  return row ?? null;
}

/** The live (non-archived) skill with this name in a project, or null — backs the
 * v1 `POST /skills/import` upsert-by-name (names are unique among a project's
 * non-archived rows, so this is a single row). */
export async function getActiveSkillByName(
  projectId: string,
  name: string,
  db: SkillsDb = getDb(),
): Promise<Skill | null> {
  const [row] = await db
    .select()
    .from(skills)
    .where(
      and(eq(skills.projectId, projectId), eq(skills.name, name), ne(skills.status, "archived")),
    )
    .limit(1);
  return row ?? null;
}

/**
 * One skill by id, with the organization that owns its project.
 *
 * The organization is RETURNED rather than filtered on, so the caller decides
 * what authorizes access, which for the catalog routes is membership, not the
 * session's active-organization pointer. This replaced a
 * `getSkillForOrganization(organizationId, id)` helper that baked the pointer in
 * and made writes narrower than the page reads they belonged to.
 */
export async function getSkillWithOrganizationId(
  id: string,
  db: SkillsDb = getDb(),
): Promise<{ skill: Skill; organizationId: string } | null> {
  const [row] = await db
    .select({
      skill: getTableColumns(skills),
      organizationId: projects.organizationId,
    })
    .from(skills)
    .innerJoin(projects, eq(skills.projectId, projects.id))
    .where(eq(skills.id, id))
    .limit(1);
  return row ? { skill: row.skill, organizationId: row.organizationId } : null;
}

/**
 * A project's skills (optionally filtered by status and/or scope), most-recently-
 * updated first. `endUser` is three-state: `undefined` = all scopes, `null` =
 * global-only, a string = only that end-user's skills.
 */
export async function listSkills(
  projectId: string,
  opts: {
    status?: SkillStatus;
    endUser?: string | null;
    limit?: number;
    offset?: number;
  } = {},
  db: SkillsDb = getDb(),
): Promise<Skill[]> {
  return db
    .select()
    .from(skills)
    .where(
      and(
        eq(skills.projectId, projectId),
        opts.status ? eq(skills.status, opts.status) : undefined,
        opts.endUser === undefined
          ? undefined
          : opts.endUser === null
            ? isNull(skills.endUserId)
            : eq(skills.endUserId, opts.endUser),
      ),
    )
    .orderBy(desc(skills.updatedAt))
    .limit(opts.limit ?? 100)
    .offset(opts.offset ?? 0);
}

/**
 * Edit a skill under OPTIONAL optimistic concurrency: when `expectedVersion` is
 * given, the update only lands while the stored `version` still equals it (then
 * bumps it); when omitted, the edit applies unconditionally (the v1 write surface
 * lets a client PATCH without a guard, mirroring publish/archive). A no-op update
 * means either the skill is gone (404) or, under a guard, someone else edited it
 * first (409) — resolved by a follow-up existence check. A duplicate active name
 * surfaces as `name_conflict`. Recomputes the catalog version when the edited skill
 * is published.
 */
export async function updateSkill(
  projectId: string,
  id: string,
  expectedVersion: number | undefined,
  patch: SkillEditPatch,
  db: SkillsDb = getDb(),
): Promise<SkillMutationResult> {
  const conds = [eq(skills.projectId, projectId), eq(skills.id, id)];
  if (expectedVersion != null) conds.push(eq(skills.version, expectedVersion));
  let rows: Skill[];
  try {
    rows = await db
      .update(skills)
      .set({ ...patch, version: sql`${skills.version} + 1`, updatedAt: new Date() })
      .where(and(...conds))
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "name_conflict" };
    throw err;
  }
  const row = rows[0];
  if (row) {
    if (row.status === "published") await recomputeCatalogVersion(projectId, db);
    return { ok: true, skill: row };
  }
  const existing = await getSkillById(projectId, id, db);
  return { ok: false, reason: existing ? "version_conflict" : "not_found" };
}

/**
 * Transition a skill's lifecycle status (publish / archive / unpublish), bumping its
 * version and stamping `published_at` on publish. An optional `expectedVersion`
 * guards the transition the same way an edit does. Recomputes the catalog version
 * whenever the published set changes — i.e. the skill is being published, or was
 * published before this transition.
 */
export async function setSkillStatus(
  projectId: string,
  id: string,
  status: SkillStatus,
  opts: { expectedVersion?: number } = {},
  db: SkillsDb = getDb(),
): Promise<SkillMutationResult> {
  const current = await getSkillById(projectId, id, db);
  if (!current) return { ok: false, reason: "not_found" };
  if (opts.expectedVersion != null && current.version !== opts.expectedVersion) {
    return { ok: false, reason: "version_conflict" };
  }

  const now = new Date();
  const conds = [eq(skills.projectId, projectId), eq(skills.id, id)];
  if (opts.expectedVersion != null) conds.push(eq(skills.version, opts.expectedVersion));

  let rows: Skill[];
  try {
    rows = await db
      .update(skills)
      .set({
        status,
        version: sql`${skills.version} + 1`,
        updatedAt: now,
        ...(status === "published" ? { publishedAt: now } : {}),
      })
      .where(and(...conds))
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "name_conflict" };
    throw err;
  }

  const row = rows[0];
  if (!row) {
    // Lost the CAS race between the read and the guarded update.
    const existing = await getSkillById(projectId, id, db);
    return { ok: false, reason: existing ? "version_conflict" : "not_found" };
  }
  if (current.status === "published" || status === "published") {
    await recomputeCatalogVersion(projectId, db);
  }
  return { ok: true, skill: row };
}
