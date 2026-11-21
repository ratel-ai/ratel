"use client";

import { toast } from "@ratel/design-system/toast";
import { useState } from "react";
import { editSkill } from "@/lib/console/explore/client";
import { explainMutationError } from "@/lib/console/explore/errors";
import { updateRuntimeCatalogOverride } from "@/lib/ingest/runtime-catalog/override-client";
import { applySkillDraft } from "@/lib/synthesis/playground/bench";
import type { Bench } from "@/lib/synthesis/playground/catalog";
import type { DraftsByKind } from "@/lib/synthesis/playground/types";

/**
 * Writing a tested description to the catalog: the one action on this page that
 * leaves the browser. Both writes go through the routes the Catalog uses, so a
 * save here is the same save as there.
 *
 * Resolves true once written. On failure the draft is left alone (the reader's
 * wording is the only copy) and a toast says what went wrong.
 */
export function useCatalogSave({
  projectId,
  bench,
  getDrafts,
}: {
  projectId: string;
  bench: Bench;
  getDrafts: () => DraftsByKind;
}) {
  const [savingId, setSavingId] = useState<string | null>(null);

  /**
   * A skill: the field retrieval reads for it, plus its tags. This does NOT
   * publish; a draft skill stays a draft, and Catalog owns that decision.
   */
  async function saveSkill(name: string, description: string | null): Promise<boolean> {
    const skill = bench.skills.find((candidate) => candidate.name === name);
    if (!skill) return false;
    const drafted = applySkillDraft(skill, getDrafts().skill[name]);
    setSavingId(name);
    const edited = await editSkill(skill.id, {
      expectedVersion: skill.version,
      // Null clears a separate searchable description, so retrieval falls back
      // to the description. Trimmed here, never while typing.
      ...(skill.searchableDescription === null
        ? { description: (description ?? "").trim() }
        : { searchableDescription: description === null ? null : description.trim() }),
      tags: drafted.tags,
    });
    setSavingId(null);
    if (!edited.ok) {
      toast({
        title:
          edited.reason === "version_conflict"
            ? `${name} changed since this page loaded. Reload, then test your change again.`
            : explainMutationError(edited.status, edited.reason),
        tone: "danger",
      });
      return false;
    }
    toast({
      title: `Saved ${name} to the catalog`,
      description:
        skill.status === "draft" ? "It is still a draft. Publish it from Catalog." : undefined,
      tone: "success",
    });
    return true;
  }

  /**
   * A managed tool's searchable description, as a Cloud override (null clears
   * it so the runtime's own text applies again). The agent description is not
   * Cloud's to write; it belongs to whoever runs the agent.
   */
  async function saveTool(name: string, description: string | null): Promise<boolean> {
    const tool = bench.tools.find((candidate) => candidate.name === name);
    if (!tool || tool.entryId === null) return false;
    setSavingId(name);
    const result = await updateRuntimeCatalogOverride(fetch, {
      projectId,
      kind: "tool",
      searchableDescription: description === null ? null : description.trim(),
      entryId: tool.entryId,
    });
    setSavingId(null);
    if (!result.ok) {
      toast({ title: result.error, tone: "danger" });
      return false;
    }
    toast({
      title:
        description === null
          ? `${name} uses your runtime's description again`
          : `Saved the searchable description for ${name}`,
      description: "Your agent matches on it from its next catalog sync.",
      tone: "success",
    });
    return true;
  }

  return { savingId, saveSkill, saveTool };
}
