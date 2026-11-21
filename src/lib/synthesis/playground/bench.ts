import { hasOwnSearchableDescription, resolveSearchableDescription } from "./descriptions";
import type { BenchSkill, BenchTool, CapabilityDraft, CapabilityKind, DraftsByKind } from "./types";

/**
 * The what-if layer: fold a user's drafts over the baseline catalog and describe
 * what changed. Pure (no DB, no engine), so the diff the UI shows and the text
 * the ranker indexes are derived from one place and cannot drift apart.
 *
 * A draft always edits the text RETRIEVAL READS. Which field that is depends on
 * the capability: an entry the runtime has ingested keeps its match text in the
 * searchable description, so the edit lands there (and is savable as an
 * override); a capability with no separate retrieval text has exactly one
 * description, so the edit lands on that. Either way the bench ranks the thing
 * you just typed, which is the only promise this surface makes.
 *
 * The draft field stays named `description` on the wire. It is the description
 * you are editing; renaming it would invalidate every stored draft in every
 * reader's browser for no gain.
 */

/** A field-level change between the baseline and the drafted value. */
export interface FieldChange {
  field: "description" | "tags";
  before: string;
  after: string;
}

export interface CapabilityChange {
  kind: CapabilityKind;
  id: string;
  changes: FieldChange[];
}

export const emptyDrafts = (): DraftsByKind => ({ skill: {}, tool: {} });

/**
 * A draft field, as typed.
 *
 * Whitespace-only means "no edit" rather than "empty text": clearing the box
 * falls back to the stored description instead of ranking on nothing. But the
 * value is otherwise kept VERBATIM: this feeds a controlled textarea, so
 * trimming here meant the trailing space of a word you were still typing was
 * deleted the instant you pressed it. Trimming belongs at the save boundary,
 * not on every keystroke.
 */
function draftText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() === "" ? undefined : value;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

/** The skill as it would be indexed with its draft applied. */
export function applySkillDraft(skill: BenchSkill, draft: CapabilityDraft | undefined): BenchSkill {
  if (!draft) return skill;
  const tags = draft.tags ?? skill.tags;
  const description = draftText(draft.description);
  if (description === undefined) return { ...skill, tags };
  return hasOwnSearchableDescription(skill)
    ? { ...skill, searchableDescription: description, tags }
    : { ...skill, description, tags };
}

/** The tool as it would be indexed with its hypothetical draft applied. */
export function applyToolDraft(tool: BenchTool, draft: CapabilityDraft | undefined): BenchTool {
  if (!draft) return tool;
  const description = draftText(draft.description);
  if (description === undefined) return tool;
  return hasOwnSearchableDescription(tool)
    ? { ...tool, searchableDescriptionOverride: description }
    : { ...tool, description };
}

/**
 * Whether a draft actually differs from its baseline. A draft that was typed
 * and then reverted is still stored (the textarea holds it), so "has a draft"
 * and "is edited" are different questions; the ranker and the diff both want
 * the second one.
 */
export function skillIsEdited(skill: BenchSkill, draft: CapabilityDraft | undefined): boolean {
  const drafted = applySkillDraft(skill, draft);
  return (
    !sameText(resolveSearchableDescription(drafted), resolveSearchableDescription(skill)) ||
    !sameTags(drafted.tags, skill.tags)
  );
}

export function toolIsEdited(tool: BenchTool, draft: CapabilityDraft | undefined): boolean {
  return !sameText(
    resolveSearchableDescription(applyToolDraft(tool, draft)),
    resolveSearchableDescription(tool),
  );
}

/**
 * Compared trimmed, so pressing space at the end of a description does not by
 * itself mark the row edited, raise the unsaved-edits count, and offer a Save
 * that would change nothing.
 */
function sameText(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/** Every capability whose draft changes something, with its field-level diff. */
export function summarizeChanges(
  skills: readonly BenchSkill[],
  tools: readonly BenchTool[],
  drafts: DraftsByKind,
): CapabilityChange[] {
  const changes: CapabilityChange[] = [];

  for (const skill of skills) {
    const draft = drafts.skill[skill.name];
    if (!skillIsEdited(skill, draft)) continue;
    const drafted = applySkillDraft(skill, draft);
    const fields: FieldChange[] = [];
    if (!sameText(resolveSearchableDescription(drafted), resolveSearchableDescription(skill))) {
      fields.push({
        field: "description",
        before: resolveSearchableDescription(skill),
        after: resolveSearchableDescription(drafted),
      });
    }
    if (!sameTags(drafted.tags, skill.tags)) {
      fields.push({
        field: "tags",
        before: skill.tags.join(", "),
        after: drafted.tags.join(", "),
      });
    }
    changes.push({ kind: "skill", id: skill.name, changes: fields });
  }

  for (const tool of tools) {
    const draft = drafts.tool[tool.name];
    if (!toolIsEdited(tool, draft)) continue;
    changes.push({
      kind: "tool",
      id: tool.name,
      changes: [
        {
          field: "description",
          before: resolveSearchableDescription(tool),
          after: resolveSearchableDescription(applyToolDraft(tool, draft)),
        },
      ],
    });
  }

  return changes;
}

/** Ids of the capabilities a run should mark as edited, per kind. */
export function editedIds(
  skills: readonly BenchSkill[],
  tools: readonly BenchTool[],
  drafts: DraftsByKind,
): { skills: Set<string>; tools: Set<string> } {
  return {
    skills: new Set(
      skills
        .filter((skill) => skillIsEdited(skill, drafts.skill[skill.name]))
        .map((skill) => skill.name),
    ),
    tools: new Set(
      tools.filter((tool) => toolIsEdited(tool, drafts.tool[tool.name])).map((tool) => tool.name),
    ),
  };
}
