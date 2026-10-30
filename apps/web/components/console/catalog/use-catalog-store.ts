"use client";

import { toast } from "@ratel/design-system/toast";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SkillFull } from "@/lib/catalog/agent-tools/outputs";
import {
  commitSearchable,
  NOT_EDITABLE,
  transitionSkill as runTransition,
  type WriteResult,
} from "@/lib/console/catalog/actions";
import {
  buildSkillItems,
  type CatalogItem,
  overrideKey,
  type SearchableTarget,
  type SkillTransition,
  toolItemFromRow,
  withRuntimeOverrides,
  withSkillRecords,
} from "@/lib/console/catalog/items";
import type { SkillsCatalogData, ToolsCatalogData } from "@/lib/console/catalog/load";
import {
  planSearchableReset,
  planSearchableSave,
  targetAfterWrite,
} from "@/lib/console/catalog/searchable";
import { buildToolsCatalogRows } from "@/lib/console/catalog/table-view";
import { editSkill, type MutationResult, setSkillStatus } from "@/lib/console/explore/client";
import { explainMutationError } from "@/lib/console/explore/errors";
import { updateRuntimeCatalogOverride } from "@/lib/ingest/runtime-catalog/override-client";
import { readDrafts, useStoredDrafts, writeDrafts } from "./draft-storage";

/**
 * The Catalog's client state: the items built from what the server loaded,
 * plus every write made on this page, applied at once so the tree, the tables
 * and the detail agree without re-reading the catalog. Writes go through the
 * routes v1 uses (the runtime-catalog override PATCH and the skills catalog
 * routes); the flows themselves live in `lib/catalog/v2/actions.ts`.
 *
 * Unsaved searchable-description drafts are kept per item in session storage
 * (`draft-storage.ts`), so picking another item, following an in-app link or
 * coming back later in the session finds the draft where it was left, and
 * closing the tab with one asks first.
 */

const SAVE_FAILED = "Couldn't save the description. Try again in a moment.";

function skillWriteError(result: Extract<MutationResult<unknown>, { ok: false }>): string {
  if (result.reason === "version_conflict") {
    return "This skill changed in the meantime. Reload to see the latest, then try again.";
  }
  return result.status === 0 ? SAVE_FAILED : explainMutationError(result.status, result.reason);
}

export function useCatalogStore({
  projectId,
  tools,
  skills,
}: {
  projectId: string;
  tools?: ToolsCatalogData;
  skills?: SkillsCatalogData;
}) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const [records, setRecords] = useState<ReadonlyMap<string, SkillFull>>(() => new Map());
  const drafts = useStoredDrafts(projectId);
  // Mirrors of the two maps for the async flows (Undo runs seconds after the render that made it).
  const latestOverrides = useRef(new Map<string, string | null>());
  const latestRecords = useRef(new Map<string, SkillFull>());

  const toolRows = useMemo(() => {
    if (!tools) return [];
    const entries = withRuntimeOverrides(tools.runtimeEntries, "tool", overrides);
    return buildToolsCatalogRows(tools.tools, new Map(entries.map((entry) => [entry.name, entry])));
  }, [tools, overrides]);

  const toolItems = useMemo(
    () => toolRows.map((row) => toolItemFromRow(row, { editable: tools?.editable ?? false })),
    [toolRows, tools?.editable],
  );

  const skillItems = useMemo(
    () =>
      skills
        ? buildSkillItems({
            skills: withSkillRecords(skills.skills, records),
            runtimeSkills: withRuntimeOverrides(skills.runtimeSkills, "skill", overrides),
            runs: skills.runs,
            searchableEnabled: skills.searchableEnabled,
            runtimeEditable: skills.runtimeEditable,
          })
        : [],
    [skills, records, overrides],
  );

  const applyRecord = useCallback((record: SkillFull) => {
    latestRecords.current.set(record.id, record);
    setRecords((current) => new Map(current).set(record.id, record));
  }, []);

  const write = useCallback(
    async (target: SearchableTarget, stored: string | null): Promise<WriteResult> => {
      if (target.type === "runtime") {
        let result: Awaited<ReturnType<typeof updateRuntimeCatalogOverride>>;
        try {
          result = await updateRuntimeCatalogOverride(fetch, {
            projectId,
            kind: target.kind,
            entryId: target.entryId,
            searchableDescription: stored,
          });
        } catch {
          // The request never reached the route (offline, aborted); the caller shows this under the field.
          return { ok: false, error: SAVE_FAILED };
        }
        if (!result.ok) return { ok: false, error: result.error };
        const key = overrideKey(target.kind, target.entryId);
        const saved = result.searchableDescription;
        latestOverrides.current.set(key, saved);
        setOverrides((current) => new Map(current).set(key, saved));
        return { ok: true, target: targetAfterWrite(target, saved) };
      }
      const result = await editSkill(target.skillId, {
        expectedVersion: target.version,
        searchableDescription: stored,
      });
      if (!result.ok) return { ok: false, error: skillWriteError(result) };
      applyRecord(result.data);
      return {
        ok: true,
        target: targetAfterWrite(target, result.data.searchableDescription, result.data.version),
      };
    },
    [projectId, applyRecord],
  );

  /** The entry as this page last saw it: the newest Cloud copy, or the newest skill version. */
  const current = useCallback((target: SearchableTarget): SearchableTarget | undefined => {
    if (target.type === "runtime") {
      const key = overrideKey(target.kind, target.entryId);
      return latestOverrides.current.has(key)
        ? { ...target, override: latestOverrides.current.get(key) ?? null }
        : undefined;
    }
    const record = latestRecords.current.get(target.skillId);
    return record
      ? { ...target, version: record.version, stored: record.searchableDescription }
      : undefined;
  }, []);

  /** Save a draft. Resolves to an error to show under the field, or null once saved. */
  const saveSearchable = useCallback(
    (item: CatalogItem, draft: string) =>
      item.searchable
        ? commitSearchable(
            { write, current, toast },
            item,
            planSearchableSave(item.searchable.target, item.agentDescription ?? "", draft),
          )
        : Promise.resolve(NOT_EDITABLE),
    [write, current],
  );

  /** Drop the Cloud copy of a runtime entry's text. */
  const resetSearchable = useCallback(
    (item: CatalogItem) =>
      item.searchable
        ? commitSearchable(
            { write, current, toast },
            item,
            planSearchableReset(item.searchable.target),
          )
        : Promise.resolve(null),
    [write, current],
  );

  /** Publish or archive a Cloud skill, with Undo when the way back is exact. */
  const transitionSkill = useCallback(
    async (item: CatalogItem, transition: SkillTransition) => {
      const record = item.kind === "skill" ? item.record : null;
      if (!record) return;
      await runTransition(
        {
          setStatus: setSkillStatus,
          apply: applyRecord,
          latest: (id) => latestRecords.current.get(id),
          explain: skillWriteError,
          toast,
        },
        record,
        transition,
      );
    },
    [applyRecord],
  );

  /** Keep or clear an item's unsaved searchable-description draft. */
  const setDraft = useCallback(
    (key: string, draft: string | null) => {
      const current = readDrafts(projectId);
      if (draft === null ? !current.has(key) : current.get(key) === draft) return;
      const next = new Map(current);
      if (draft === null) next.delete(key);
      else next.set(key, draft);
      writeDrafts(projectId, next);
    },
    [projectId],
  );

  // DESIGN.md, Forms: warn before leaving with unsaved changes.
  const items = useMemo(
    () => new Map([...toolItems, ...skillItems].map((item) => [item.key, item])),
    [toolItems, skillItems],
  );
  const unsaved = useMemo(
    () =>
      [...drafts].some(
        ([key, draft]) => draft.trim() !== (items.get(key)?.searchable?.text ?? "").trim(),
      ),
    [drafts, items],
  );
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  return {
    toolRows,
    toolItems,
    skillItems,
    drafts,
    setDraft,
    saveSearchable,
    resetSearchable,
    transitionSkill,
    applyRecord,
  };
}

export type CatalogStore = ReturnType<typeof useCatalogStore>;
