import type { CreateSkillInput } from "@/lib/catalog/manage";
import type {
  countSkills as countSkillsFn,
  createSkill as createSkillFn,
  getActiveSkillByName as getActiveSkillByNameFn,
  updateSkill as updateSkillFn,
} from "@/lib/catalog/queries";
import type { Skill } from "@/lib/catalog/schema";
import { checkQuota, type OrgLimitView } from "@/lib/platform/entitlements";

/**
 * The v1 bulk import: upsert-by-name over the live (non-archived) skill set, for
 * onboarding an existing SKILL.md folder. Deliberately NOT a declarative sync —
 * nothing is archived, and `status` / `endUserId` apply on create only (cloud
 * stays the source of truth; removal is an explicit archive). Injected deps
 * (pull-route-handler precedent) so the partitioning logic unit-tests without a
 * database; the catalog-ETag recompute already lives inside the mutation
 * primitives.
 */

export interface ImportDeps {
  getActiveSkillByName: typeof getActiveSkillByNameFn;
  createSkill: typeof createSkillFn;
  updateSkill: typeof updateSkillFn;
  countSkills: typeof countSkillsFn;
}

export type ImportOutcome =
  | { ok: true; created: string[]; updated: string[]; unchanged: string[] }
  | { ok: false; reason: "quota_exceeded"; limit: number; message: string }
  | { ok: false; reason: "conflict" };

/**
 * Content equality under the wire's canonicalization semantics: order-sensitive
 * on `tags`/`tools` (authored order is meaningful, `canonicalSkill` preserves
 * it), key-order-insensitive on `metadata` (keys are byte-sorted on the wire).
 */
export function sameContent(existing: Skill, input: CreateSkillInput): boolean {
  if (existing.description !== input.description || existing.body !== input.body) return false;
  if (existing.searchableDescription !== (input.searchableDescription ?? null)) return false;
  if (!sameArray(existing.tags, input.tags)) return false;
  if (!sameArray(existing.tools, input.tools)) return false;
  const a = existing.metadata;
  const b = input.metadata;
  const keys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (keys.length !== bKeys.length) return false;
  return keys.every((k, i) => k === bKeys[i] && sameArray(a[k] ?? [], b[k] ?? []));
}

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function importSkills(
  projectId: string,
  org: OrgLimitView,
  inputs: CreateSkillInput[],
  deps: ImportDeps,
): Promise<ImportOutcome> {
  // Pre-scan: which names already exist live? Quota-gate the whole batch on the
  // resulting create count BEFORE any write, so a blocked import is all-or-nothing.
  const existingByName = new Map<string, Skill>();
  for (const input of inputs) {
    const existing = await deps.getActiveSkillByName(projectId, input.name);
    if (existing) existingByName.set(input.name, existing);
  }
  const toCreate = inputs.filter((i) => !existingByName.has(i.name)).length;
  if (toCreate > 0) {
    const current = await deps.countSkills(projectId);
    // checkQuota passes when currentCount < limit; the last create must satisfy
    // current + toCreate - 1 < limit, i.e. current + toCreate <= limit.
    const quota = checkQuota(org, "maxSkillsPerProject", current + toCreate - 1);
    if (!quota.ok) {
      return { ok: false, reason: "quota_exceeded", limit: quota.limit, message: quota.message };
    }
  }

  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];

  for (const input of inputs) {
    let existing = existingByName.get(input.name) ?? null;

    if (!existing) {
      const result = await deps.createSkill({
        projectId,
        name: input.name,
        description: input.description,
        searchableDescription: input.searchableDescription ?? null,
        body: input.body,
        tags: input.tags,
        tools: input.tools,
        metadata: input.metadata,
        status: input.status,
        model: input.model ?? null,
        endUserId: input.endUserId ?? null,
      });
      if (result.ok) {
        created.push(input.name);
        continue;
      }
      // name_conflict: someone created it between pre-scan and now — re-read and
      // fall through to the update path.
      existing = await deps.getActiveSkillByName(projectId, input.name);
      if (!existing) return { ok: false, reason: "conflict" };
    }

    if (sameContent(existing, input)) {
      unchanged.push(input.name);
      continue;
    }

    const patch = {
      description: input.description,
      searchableDescription: input.searchableDescription ?? null,
      body: input.body,
      tags: input.tags,
      tools: input.tools,
      metadata: input.metadata,
    };
    let result = await deps.updateSkill(projectId, existing.id, existing.version, patch);
    if (!result.ok && result.reason === "version_conflict") {
      // One re-read-and-retry; a second loss means live contention — give up.
      const reread = await deps.getActiveSkillByName(projectId, input.name);
      if (!reread) return { ok: false, reason: "conflict" };
      if (sameContent(reread, input)) {
        unchanged.push(input.name);
        continue;
      }
      result = await deps.updateSkill(projectId, reread.id, reread.version, patch);
    }
    if (!result.ok) return { ok: false, reason: "conflict" };
    updated.push(input.name);
  }

  return { ok: true, created, updated, unchanged };
}
