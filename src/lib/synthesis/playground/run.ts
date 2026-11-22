import {
  diffRankings,
  type RankingDiffEntry,
  type RankingDiffSummary,
  summarizeRankingDiff,
} from "@/lib/synthesis/experiments/ranking";
import {
  applySkillDraft,
  applyToolDraft,
  type CapabilityChange,
  editedIds,
  summarizeChanges,
} from "./bench";
import { type EmbeddingVectors, rankCapabilities } from "./rank";
import type { BenchSkill, BenchTool, DraftsByKind, RankedBuckets, RankOptions } from "./types";

/**
 * One Playground run: rank the query twice, once against the catalog as it is
 * stored and once with the drafts applied, then diff the two.
 *
 * The diff reuses `lib/experiments/ranking`, the same alignment Calibration
 * shows for a served-versus-shadow selection. That is the point: a what-if edit
 * is read with the exact vocabulary ("moved", "dropped", "added") that a real
 * arm comparison is read with, so a Playground result can be held next to a
 * recorded mismatch without translating between two notions of "changed".
 */

export interface BucketDiff {
  entries: RankingDiffEntry[];
  summary: RankingDiffSummary;
}

export interface PlaygroundRun {
  baseline: RankedBuckets;
  /** Identical to `baseline` when nothing is edited. */
  drafted: RankedBuckets;
  diff: { skills: BucketDiff; tools: BucketDiff };
  changes: CapabilityChange[];
  hasEdits: boolean;
}

function bucketDiff(before: readonly string[], after: readonly string[]): BucketDiff {
  const entries = diffRankings([...before], [...after]);
  return { entries, summary: summarizeRankingDiff(entries) };
}

export interface RunInput {
  query: string;
  skills: readonly BenchSkill[];
  tools: readonly BenchTool[];
  drafts: DraftsByKind;
  options: RankOptions;
  /** Vectors for the SAVED text, required outside `bm25` mode. */
  baselineVectors?: EmbeddingVectors;
  /** Vectors for the DRAFTED text. Falls back to the saved set when unedited. */
  draftedVectors?: EmbeddingVectors;
}

export function runPlayground(input: RunInput): PlaygroundRun {
  const { query, skills, tools, drafts, options } = input;
  const edited = editedIds(skills, tools, drafts);
  const hasEdits = edited.skills.size > 0 || edited.tools.size > 0;

  const baseline = rankCapabilities({
    query,
    skills,
    tools,
    editedSkillIds: new Set(),
    editedToolIds: new Set(),
    options,
    vectors: input.baselineVectors,
  });

  const drafted = hasEdits
    ? rankCapabilities({
        query,
        skills: skills.map((skill) => applySkillDraft(skill, drafts.skill[skill.name])),
        tools: tools.map((tool) => applyToolDraft(tool, drafts.tool[tool.name])),
        editedSkillIds: edited.skills,
        editedToolIds: edited.tools,
        options,
        vectors: input.draftedVectors ?? input.baselineVectors,
      })
    : baseline;

  return {
    baseline,
    drafted,
    diff: {
      skills: bucketDiff(
        baseline.skills.map((hit) => hit.id),
        drafted.skills.map((hit) => hit.id),
      ),
      tools: bucketDiff(
        baseline.tools.map((hit) => hit.id),
        drafted.tools.map((hit) => hit.id),
      ),
    },
    changes: summarizeChanges(skills, tools, drafts),
    hasEdits,
  };
}
