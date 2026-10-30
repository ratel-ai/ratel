import {
  applySkillDraft,
  applyToolDraft,
  skillIsEdited,
  toolIsEdited,
} from "@/lib/synthesis/playground/bench";
import { resolveSearchableDescription } from "@/lib/synthesis/playground/descriptions";
import type { BenchSkill, BenchTool, DraftsByKind } from "@/lib/synthesis/playground/types";

/**
 * Taking the what-if edits somewhere else.
 *
 * A Playground edit is a proposal, and most of them cannot be applied from
 * here: a tool's description belongs to whoever runs the agent, and even a
 * skill often needs the change to land in the repository the catalog is synced
 * from rather than in Cloud. So the surface has to be able to hand the work
 * over, and the two shapes people actually paste into are a diff (for a human,
 * or for an agent told to "make these changes") and JSON (for anything that
 * parses).
 *
 * Both are built from the same `EditedCapability` list, so the two exports can
 * never disagree about what changed.
 */

export interface EditedCapability {
  kind: "skill" | "tool";
  id: string;
  /**
   * The text retrieval matches on, before and after. For a managed entry that
   * is its searchable description, not the agent description, which is the one
   * an edit here can actually change, and the one the receiving end has to
   * apply.
   */
  description: { from: string; to: string };
  /** Skills only, and only when the tags actually changed. */
  tags?: { from: string[]; to: string[] };
}

export interface ExportContext {
  projectSlug: string;
  /** Stamped by the caller: this module stays pure and testable. */
  generatedAt: string;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

/**
 * Every capability whose stored text differs from the bench's current reading,
 * skills first then tools, alphabetical within each. A stable order matters:
 * the export is something people diff and re-paste, and a set that reshuffled
 * between copies would look like a change that never happened.
 */
export function collectEdits(
  skills: readonly BenchSkill[],
  tools: readonly BenchTool[],
  drafts: DraftsByKind,
): EditedCapability[] {
  const edited: EditedCapability[] = [];

  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    const draft = drafts.skill[skill.name];
    if (!skillIsEdited(skill, draft)) continue;
    const applied = applySkillDraft(skill, draft);
    const entry: EditedCapability = {
      kind: "skill",
      id: skill.name,
      description: {
        from: resolveSearchableDescription(skill),
        to: resolveSearchableDescription(applied),
      },
    };
    if (!sameTags(skill.tags, applied.tags)) {
      entry.tags = { from: skill.tags, to: applied.tags };
    }
    edited.push(entry);
  }

  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const draft = drafts.tool[tool.name];
    if (!toolIsEdited(tool, draft)) continue;
    edited.push({
      kind: "tool",
      id: tool.name,
      description: {
        from: resolveSearchableDescription(tool),
        to: resolveSearchableDescription(applyToolDraft(tool, draft)),
      },
    });
  }

  return edited;
}

export function editsToJson(edits: readonly EditedCapability[], context: ExportContext): string {
  return `${JSON.stringify(
    {
      source: "ratel-test-a-search",
      project: context.projectSlug,
      generatedAt: context.generatedAt,
      edits,
    },
    null,
    2,
  )}\n`;
}

/** Every line of `text` prefixed, with an empty description shown as absent. */
function block(text: string, marker: "-" | "+"): string {
  const trimmed = text.trim();
  if (trimmed === "") return `${marker}(no description)`;
  return trimmed
    .split("\n")
    .map((line) => `${marker}${line}`)
    .join("\n");
}

/**
 * The edits as a unified-diff-shaped document.
 *
 * Not a real patch against real files, and it does not pretend to be: Ratel
 * does not know the path a capability lives at in the reader's repository. What
 * it is is the format both humans and coding agents already read as "here is a
 * before and an after", with the capability's kind and id as the header so the
 * receiving end knows what to change.
 */
export function editsToDiff(edits: readonly EditedCapability[], context: ExportContext): string {
  const lines: string[] = [
    `# Test a search edits: ${context.projectSlug}`,
    `# ${edits.length} capabilit${edits.length === 1 ? "y" : "ies"}, ${context.generatedAt}`,
    "#",
    "# Proposed description changes, tested against this project's catalog.",
    "# Tool descriptions live with whoever runs the agent; apply them there.",
  ];

  for (const edit of edits) {
    lines.push(
      "",
      `--- a/${edit.kind}/${edit.id}`,
      `+++ b/${edit.kind}/${edit.id}`,
      "@@ description @@",
      block(edit.description.from, "-"),
      block(edit.description.to, "+"),
    );
    if (edit.tags) {
      lines.push(
        "@@ tags @@",
        `-${edit.tags.from.join(", ") || "(none)"}`,
        `+${edit.tags.to.join(", ") || "(none)"}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
