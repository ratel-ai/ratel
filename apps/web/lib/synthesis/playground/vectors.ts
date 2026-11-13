import { applySkillDraft, applyToolDraft, editedIds } from "./bench";
import { capabilityIndexText, type EmbeddingVectors } from "./rank";
import type { BenchSkill, BenchTool, DraftsByKind } from "./types";

/**
 * Laying out an embedding batch and reading the vectors back out of it.
 *
 * Split out of the route because it is pure index arithmetic over two batches
 * whose lengths depend on how many capabilities are edited, and an off-by-one
 * here does not fail loudly. It silently attaches one capability's vector to
 * another, which shows up as a ranking that is merely a bit wrong.
 *
 * Layout:
 *   skills batch: [query, ...every skill, ...only the EDITED skills, drafted]
 *   tools batch:  [       ...every tool,  ...only the EDITED tools,  drafted]
 *
 * The query rides in the skills batch alone. Both batches go out concurrently,
 * so including it twice would race the process cache and pay for it twice; one
 * query vector serves both buckets regardless.
 */

export interface VectorBatches {
  skillTexts: string[];
  toolTexts: string[];
}

export interface Catalogs {
  skills: readonly BenchSkill[];
  tools: readonly BenchTool[];
}

/** The texts to embed, in the exact order `assembleVectors` reads them back. */
export function planVectorBatches(
  query: string,
  catalogs: Catalogs,
  drafts: DraftsByKind,
): VectorBatches {
  const { editedSkills, editedTools } = draftedCapabilities(catalogs, drafts);
  return {
    skillTexts: [
      query,
      ...catalogs.skills.map(capabilityIndexText),
      ...editedSkills.map(capabilityIndexText),
    ],
    toolTexts: [
      ...catalogs.tools.map(capabilityIndexText),
      ...editedTools.map(capabilityIndexText),
    ],
  };
}

/**
 * Read the batches back into a baseline and a drafted vector set. The drafted
 * set starts as a copy of the baseline and only the edited capabilities are
 * overwritten: an unedited capability is the same text in both runs, so it
 * must be the same vector too.
 */
export function assembleVectors(
  catalogs: Catalogs,
  drafts: DraftsByKind,
  skillVectors: readonly number[][],
  toolVectors: readonly number[][],
): { baseline: EmbeddingVectors; drafted: EmbeddingVectors } {
  const { editedSkills, editedTools } = draftedCapabilities(catalogs, drafts);
  const queryVector = skillVectors[0] ?? [];

  const skillBase = new Map(
    catalogs.skills.map((skill, index) => [skill.name, skillVectors[index + 1] ?? []]),
  );
  const toolBase = new Map(
    catalogs.tools.map((tool, index) => [tool.name, toolVectors[index] ?? []]),
  );

  const skillDrafted = new Map(skillBase);
  editedSkills.forEach((skill, index) => {
    skillDrafted.set(skill.name, skillVectors[1 + catalogs.skills.length + index] ?? []);
  });
  const toolDrafted = new Map(toolBase);
  editedTools.forEach((tool, index) => {
    toolDrafted.set(tool.name, toolVectors[catalogs.tools.length + index] ?? []);
  });

  return {
    baseline: { query: queryVector, skills: skillBase, tools: toolBase },
    drafted: { query: queryVector, skills: skillDrafted, tools: toolDrafted },
  };
}

/** The edited capabilities, in catalog order: the order both batches use. */
function draftedCapabilities(catalogs: Catalogs, drafts: DraftsByKind) {
  const edited = editedIds(catalogs.skills, catalogs.tools, drafts);
  return {
    editedSkills: catalogs.skills
      .filter((skill) => edited.skills.has(skill.name))
      .map((skill) => applySkillDraft(skill, drafts.skill[skill.name])),
    editedTools: catalogs.tools
      .filter((tool) => edited.tools.has(tool.name))
      .map((tool) => applyToolDraft(tool, drafts.tool[tool.name])),
  };
}
