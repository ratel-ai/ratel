/**
 * Pure helpers for the Explore skills editor: turn the flat text form into the exact
 * JSON bodies the `/api/skills-catalog` routes expect. `buildEditPayload` sends only
 * the fields that actually changed (the PATCH route requires ≥1, so an unchanged form
 * yields just `{ expectedVersion }`, which the caller treats as "nothing to save").
 * No React / no fetch here — these are unit-tested standalone.
 */

/** The editor's flat form state (tags/tools are comma-separated text; endUser is
 * the scope field — empty = global). */
export interface SkillFormValues {
  name: string;
  description: string;
  searchableDescription: string;
  useSearchableDescription: boolean;
  body: string;
  tags: string;
  tools: string;
  status: "draft" | "published";
  model: string;
  endUser: string;
}

/** The subset of a skill the edit form is seeded from + diffed against. */
export interface SkillOriginal {
  name: string;
  description: string;
  searchableDescription: string | null;
  body: string;
  tags: string[];
  tools: string[];
  endUserId: string | null;
}

export type CreateSkillBody = {
  project: string;
  name: string;
  description: string;
  searchableDescription: string | null;
  body: string;
  tags: string[];
  tools: string[];
  status: "draft" | "published";
  model?: string;
  endUserId?: string;
};

export type EditSkillBody = {
  expectedVersion: number;
  name?: string;
  description?: string;
  /** Tri-state: absent = unchanged, string = override, null = clear override. */
  searchableDescription?: string | null;
  body?: string;
  tags?: string[];
  tools?: string[];
  /** Tri-state on the wire: absent = unchanged, string = re-scope, null = make global. */
  endUserId?: string | null;
};

/** Split a comma-separated field into trimmed, non-empty, de-duplicated entries
 * (order preserved). */
export function parseList(csv: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of csv.split(",")) {
    const v = raw.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Whether two string lists are equal element-for-element (order-sensitive). */
function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function buildCreatePayload(values: SkillFormValues, projectSlug: string): CreateSkillBody {
  const model = values.model.trim();
  const endUser = values.endUser.trim();
  return {
    project: projectSlug,
    name: values.name.trim(),
    description: values.description,
    searchableDescription: values.useSearchableDescription ? values.searchableDescription : null,
    body: values.body,
    tags: parseList(values.tags),
    tools: parseList(values.tools),
    status: values.status,
    ...(model ? { model } : {}),
    ...(endUser ? { endUserId: endUser } : {}),
  };
}

/** Build a PATCH body with only the changed fields, plus the version guard. */
export function buildEditPayload(
  values: SkillFormValues,
  original: SkillOriginal,
  expectedVersion: number,
): EditSkillBody {
  const body: EditSkillBody = { expectedVersion };
  const name = values.name.trim();
  if (name !== original.name) body.name = name;
  if (values.description !== original.description) body.description = values.description;
  const searchableDescription = values.useSearchableDescription
    ? values.searchableDescription
    : null;
  if (searchableDescription !== original.searchableDescription) {
    body.searchableDescription = searchableDescription;
  }
  if (values.body !== original.body) body.body = values.body;
  const tags = parseList(values.tags);
  if (!sameList(tags, original.tags)) body.tags = tags;
  const tools = parseList(values.tools);
  if (!sameList(tools, original.tools)) body.tools = tools;
  // Scope: an emptied field clears to global (null on the wire); unchanged → absent.
  const endUser = values.endUser.trim() || null;
  if (endUser !== original.endUserId) body.endUserId = endUser;
  return body;
}

/** True when an edit form has no changed fields (Save should be disabled). */
export function hasEdits(body: EditSkillBody): boolean {
  return Object.keys(body).some((k) => k !== "expectedVersion");
}
