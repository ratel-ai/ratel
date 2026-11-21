import type { Skill } from "@/lib/catalog/schema";
import type { SkillFull, SkillSummary } from "./outputs";

/**
 * Pure Row → JSON serializers (Date → ISO string; the summary drops the heavy
 * `body` from list rows) for the shapes in `outputs.ts`. Shared by the Explore
 * server page (`app/(app)/explore`) and any future agent surface, so the two
 * surfaces serialize identically and cannot drift.
 */

export function serializeSkillSummary(s: Skill): SkillSummary {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    searchableDescription: s.searchableDescription,
    tags: s.tags,
    tools: s.tools,
    status: s.status,
    version: s.version,
    endUserId: s.endUserId,
    model: s.model,
    updatedAt: s.updatedAt.toISOString(),
    publishedAt: s.publishedAt ? s.publishedAt.toISOString() : null,
  };
}

export function serializeSkillFull(s: Skill): SkillFull {
  return {
    ...serializeSkillSummary(s),
    metadata: s.metadata,
    body: s.body,
    createdAt: s.createdAt.toISOString(),
  };
}
