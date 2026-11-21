import { z } from "zod";

/**
 * Pure helpers for the managed skills catalog: the lifecycle vocabulary and the
 * Zod validation for create/edit inputs. No database here — the queries layer and
 * the route handlers inject persistence; these functions are unit-tested
 * standalone.
 *
 * The wire shape (and the ETag over the published set) is owned by `./wire.ts` —
 * the frozen protocol/v1 module — so management code re-exports `WireSkill` as
 * `CatalogSkillWire` rather than defining a second shape. The DB's `tools` column
 * carries the wire field directly (no remapping).
 */

/* — Lifecycle ———————————————————————————————————————————————————————————————— */

export const SKILL_STATUSES = ["draft", "published", "archived"] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

/* — Wire shape (owned by protocol/v1 wire.ts) —————————————————————————————————— */

export type { WireSkill as CatalogSkillWire } from "@/lib/catalog/wire";
export type ManagedSkillWire = import("@/lib/catalog/wire").WireSkill & {
  searchableDescription: string | null;
};

/* — Validation (create / edit / status transitions) ———————————————————————————— */

const MAX_NAME = 128;
export const MAX_DESCRIPTION = 4 * 1024;
const MAX_BODY = 256 * 1024;
const MAX_TAGS = 64;
const MAX_TAG_LEN = 128;
const MAX_TOOLS = 256;
const MAX_TOOL_LEN = 256;
const MAX_METADATA_KEYS = 64;
const MAX_METADATA_VALUES = 64;
/** Matches the trace-events id cap (`MAX_ID`) — it's the same opaque id space. */
const MAX_END_USER_ID = 512;

/** kebab-case: lowercase alphanumerics separated by single hyphens. */
export const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const name = z
  .string()
  .min(1)
  .max(MAX_NAME)
  .regex(KEBAB_RE, "name must be kebab-case (lowercase letters, digits, single hyphens)");
const description = z.string().min(1).max(MAX_DESCRIPTION);
const searchableDescription = z.string().max(MAX_DESCRIPTION);
const body = z.string().min(1).max(MAX_BODY);
const tags = z.array(z.string().min(1).max(MAX_TAG_LEN)).max(MAX_TAGS);
const tools = z.array(z.string().min(1).max(MAX_TOOL_LEN)).max(MAX_TOOLS);
const metadata = z
  .record(
    z.string().min(1).max(MAX_TAG_LEN),
    z.array(z.string().max(MAX_TAG_LEN)).max(MAX_METADATA_VALUES),
  )
  .refine(
    (m) => Object.keys(m).length <= MAX_METADATA_KEYS,
    `at most ${MAX_METADATA_KEYS} metadata keys`,
  );
// min(1): an empty string is rejected loudly rather than silently meaning
// "global" — callers express global by omitting (create) or sending null (edit).
const endUserId = z.string().min(1).max(MAX_END_USER_ID);

/** Input to create a skill. `status` may only be draft or published (never archived
 * on create); tags/tools/metadata default to empty, matching the SDK's Vec/HashMap.
 * `endUserId` scopes the skill to one opaque end-user (omit = global). Note a
 * scoped PUBLISHED skill is still NOT served by the SDK sync (global-only until
 * the SDK can identify its end-user). */
export const createSkillInput = z.object({
  name,
  description,
  searchableDescription: searchableDescription.nullable().optional(),
  body,
  tags: tags.optional().default([]),
  tools: tools.optional().default([]),
  metadata: metadata.optional().default({}),
  status: z.enum(["draft", "published"]).optional().default("draft"),
  model: z.string().max(MAX_NAME).optional(),
  endUserId: endUserId.optional(),
});
export type CreateSkillInput = z.infer<typeof createSkillInput>;

/** Input to edit a skill: an optional expected version (optimistic-concurrency
 * guard — omitted ⇒ the edit applies unconditionally) plus at least one field to
 * change. `endUserId` is tri-state: absent = unchanged, a string = re-scope to
 * that end-user, null = clear the scope (make it global). */
export const editSkillInput = z
  .object({
    expectedVersion: z.number().int().min(1).optional(),
    name: name.optional(),
    description: description.optional(),
    searchableDescription: searchableDescription.nullable().optional(),
    body: body.optional(),
    tags: tags.optional(),
    tools: tools.optional(),
    metadata: metadata.optional(),
    endUserId: endUserId.nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.searchableDescription !== undefined ||
      v.body !== undefined ||
      v.tags !== undefined ||
      v.tools !== undefined ||
      v.metadata !== undefined ||
      v.endUserId !== undefined,
    "provide at least one field to change",
  );
export type EditSkillInput = z.infer<typeof editSkillInput>;

/** Input to a publish/archive transition: an optional version guard. */
export const statusTransitionInput = z.object({
  expectedVersion: z.number().int().min(1).optional(),
});
