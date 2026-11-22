import type { ManagedSkillWire, SkillStatus } from "@/lib/catalog/manage";
import type { Skill } from "@/lib/catalog/schema";

/**
 * Serialize a catalog row for the management API. Extracted from the upstream
 * session-bound http module so the Bearer skills routes stay free of console
 * imports (ADR-0030).
 */

export type SerializedSkill = ManagedSkillWire & {
  status: SkillStatus;
  version: number;
  endUserId: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

export function serializeSkill(row: Skill): SerializedSkill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    searchableDescription: row.searchableDescription,
    tags: row.tags,
    tools: row.tools,
    metadata: row.metadata,
    body: row.body,
    status: row.status as SkillStatus,
    version: row.version,
    endUserId: row.endUserId,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}
