import { MAX_DRAFTS_PER_KIND } from "./contract";
import type { CapabilityDraft, CapabilityKind, DraftsByKind } from "./types";

/**
 * Draft persistence for the Playground bench.
 *
 * What-if edits live in the browser, not the database. Tool descriptions
 * genuinely cannot be changed from Cloud: they belong to whoever runs the
 * agent, so persisting a "tool edit" server-side would create a second,
 * authoritative-looking copy of something we do not own. Skill edits are
 * different: they CAN be published, and the publish path is the existing
 * catalog route. Until someone publishes, an edit is a scratch note, and
 * localStorage is the honest place for a scratch note.
 *
 * The parse below is defensive because this input is user-writable storage:
 * anything unrecognized is dropped rather than trusted.
 */

export const DRAFTS_STORAGE_PREFIX = "ratel.playground.drafts";

export function draftsStorageKey(projectId: string): string {
  return `${DRAFTS_STORAGE_PREFIX}.${projectId}`;
}

export const emptyDraftsByKind = (): DraftsByKind => ({ skill: {}, tool: {} });

function parseDraft(value: unknown): CapabilityDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const draft: CapabilityDraft = {};
  if (typeof record.description === "string") {
    draft.description = record.description;
  }
  if (
    Array.isArray(record.tags) &&
    record.tags.every((tag): tag is string => typeof tag === "string")
  ) {
    draft.tags = record.tags;
  }
  return draft.description === undefined && draft.tags === undefined ? null : draft;
}

function parseKind(value: unknown): Record<string, CapabilityDraft> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, CapabilityDraft> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_DRAFTS_PER_KIND) break;
    const draft = parseDraft(raw);
    if (draft) out[id] = draft;
  }
  return out;
}

/** Parse stored drafts, discarding anything malformed. Never throws. */
export function parseStoredDrafts(raw: string | null): DraftsByKind {
  if (!raw) return emptyDraftsByKind();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyDraftsByKind();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyDraftsByKind();
  const record = parsed as Record<string, unknown>;
  return { skill: parseKind(record.skill), tool: parseKind(record.tool) };
}

/** Immutably set one field of one capability's draft. */
export function setDraftField(
  drafts: DraftsByKind,
  kind: CapabilityKind,
  id: string,
  field: keyof CapabilityDraft,
  value: CapabilityDraft[keyof CapabilityDraft],
): DraftsByKind {
  return {
    ...drafts,
    [kind]: { ...drafts[kind], [id]: { ...drafts[kind][id], [field]: value } },
  };
}

/** Immutably drop one capability's draft entirely. */
export function clearDraft(drafts: DraftsByKind, kind: CapabilityKind, id: string): DraftsByKind {
  const next = { ...drafts[kind] };
  delete next[id];
  return { ...drafts, [kind]: next };
}

export function countDrafts(drafts: DraftsByKind): number {
  return Object.keys(drafts.skill).length + Object.keys(drafts.tool).length;
}
