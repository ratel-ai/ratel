"use client";

import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { editSkill } from "@/lib/console/explore/client";
import { explainMutationError } from "@/lib/console/explore/errors";
import { updateRuntimeCatalogOverride } from "@/lib/ingest/runtime-catalog/override-client";
import { applySkillDraft, skillIsEdited, toolIsEdited } from "@/lib/synthesis/playground/bench";
import {
  buildSkillEntries,
  buildToolEntries,
  ranksById,
} from "@/lib/synthesis/playground/bench-view";
import type { KindById } from "@/lib/synthesis/playground/calibration-compare";
import { sameQuery } from "@/lib/synthesis/playground/calibration-compare";
import type { Bench } from "@/lib/synthesis/playground/catalog";
import { rankPlayground } from "@/lib/synthesis/playground/client";
import type { RankResponse } from "@/lib/synthesis/playground/contract";
import { resolveSearchableDescription } from "@/lib/synthesis/playground/descriptions";
import { createDraftStore } from "@/lib/synthesis/playground/draft-store";
import {
  clearDraft,
  draftsStorageKey,
  emptyDraftsByKind,
  setDraftField,
} from "@/lib/synthesis/playground/drafts";
import { collectEdits } from "@/lib/synthesis/playground/export";
import { playgroundHref } from "@/lib/synthesis/playground/links";
import type { SuggestedPrompt } from "@/lib/synthesis/playground/prompts";
import type {
  CapabilityKind,
  DraftsByKind,
  RankMode,
  RankOptions,
} from "@/lib/synthesis/playground/types";
import type { SelectionContext } from "./CalibrationBanner";
import { CapabilityBench } from "./CapabilityBench";
import { PromptPanel } from "./PromptPanel";
import { ResultsPanel } from "./ResultsPanel";

/**
 * Strip the params the Calibration link added, shallowly.
 *
 * `history.replaceState` rather than the router: this is a correction to the
 * address bar, not a navigation, and re-running the server component would
 * refetch the selection we have just decided to forget.
 */
function forgetDeepLink(): void {
  const url = new URL(window.location.href);
  for (const param of ["selection", "experiment", "q"]) {
    url.searchParams.delete(param);
  }
  window.history.replaceState(null, "", url.toString());
}

const DEFAULT_OPTIONS: RankOptions = {
  mode: "bm25",
  topKSkills: 5,
  topKTools: 5,
  embeddingWeight: 0.5,
};

type PlaygroundWorkbenchProps = {
  projectId: string;
  projectSlug: string;
  bench: Bench;
  initialQuery: string;
  suggestions: SuggestedPrompt[];
  embeddingsEnabled: boolean;
  /**
   * Whether a managed entry's searchable description can be SAVED here, not just
   * tested. Decided on the server with the same gate the Catalogs page uses;
   * the endpoint re-checks it regardless, so this only decides what is offered.
   */
  canSaveSearchableDescription: boolean;
  selectionContext: SelectionContext | null;
};

/**
 * Test a search. State lives here rather than in the URL: a prompt plus half-written descriptions
 * is a scratchpad. What is shareable (the prompt and the recorded selection) arrives as search
 * params from the links that open this page.
 */
export function PlaygroundWorkbench({
  projectId,
  projectSlug,
  bench,
  initialQuery,
  suggestions,
  embeddingsEnabled,
  canSaveSearchableDescription,
  selectionContext,
}: PlaygroundWorkbenchProps) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [options, setOptions] = useState<RankOptions>(DEFAULT_OPTIONS);
  // The result is stored WITH the mode that produced it. Reading the current
  // control state instead would label a finished BM25 run with whatever the
  // user has since selected, and render blend components it never computed.
  const [result, setResult] = useState<{
    response: RankResponse;
    mode: RankMode;
    query: string;
  } | null>(null);
  const [running, setRunning] = useState(false);
  // Navigating to another mismatch re-renders on the server, which takes a
  // moment. Without this the menu closed and nothing moved until the new page
  // arrived, so a slow pick was indistinguishable from a dead button.
  const [navigating, startNavigation] = useTransition();
  const pending = running || navigating;
  const [savingId, setSavingId] = useState<string | null>(null);
  // Only the newest run may write results: a slow run must not land on top of
  // the one the user kicked off after it.
  const runToken = useRef(0);

  const store = useMemo(() => createDraftStore(draftsStorageKey(projectId)), [projectId]);
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const persist = useCallback((next: DraftsByKind) => store.set(next), [store]);

  // The variants ranked one query: a run for anything else drops the context and the deep link.
  const [context, setContext] = useState(selectionContext);

  const skillRanks = ranksById(result?.response.run.drafted.skills ?? []);
  const toolRanks = ranksById(result?.response.run.drafted.tools ?? []);
  const skillEntries = buildSkillEntries(bench.skills, drafts, skillRanks);
  const toolEntries = buildToolEntries(bench.tools, drafts, toolRanks);
  // One list of what changed, shared by the count on the run button, the
  // exports and the discard control, so the three can never disagree.
  const edits = useMemo(() => collectEdits(bench.skills, bench.tools, drafts), [bench, drafts]);
  const editCount = edits.length;

  /**
   * The stored MATCH text by id, for the struck-out "saved" line on an edited
   * row. It has to be the searchable description rather than the agent one:
   * the row edits what retrieval reads, so a "was" line quoting a different
   * field would show a diff nobody made.
   */
  const savedDescriptions = useMemo(
    () =>
      new Map<string, string>([
        ...bench.skills.map((skill) => [skill.name, resolveSearchableDescription(skill)] as const),
        ...bench.tools.map((tool) => [tool.name, resolveSearchableDescription(tool)] as const),
      ]),
    [bench],
  );
  const tagsById = useMemo(
    () =>
      new Map(
        bench.skills.map((skill) => [
          skill.name,
          applySkillDraft(skill, drafts.skill[skill.name]).tags,
        ]),
      ),
    [bench.skills, drafts],
  );

  /**
   * Every catalog id's kind, over the WHOLE catalog rather than a run's hits.
   * A recorded arm can name a capability nothing ranked today, and it still has
   * to land in the right bucket instead of vanishing.
   */
  const kindById: KindById = useMemo(
    () =>
      new Map<string, CapabilityKind>([
        ...bench.skills.map((skill) => [skill.name, "skill"] as const),
        ...bench.tools.map((tool) => [tool.name, "tool"] as const),
      ]),
    [bench],
  );

  /**
   * Whether the catalog is folded away.
   *
   * Starts folded. Opening on a list of several hundred rows gives the reader
   * a wall of names and no idea which end to start at, when what they came for
   * is the ranking. The bar says what is behind it and how much of it you have
   * changed; reaching for a capability from a result row opens it in place.
   */
  const [benchCollapsed, setBenchCollapsed] = useState(true);

  const [focus, setFocus] = useState<{
    id: string;
    kind: CapabilityKind;
    nonce: number;
  } | null>(null);
  const focusNonce = useRef(0);
  const focusCapability = useCallback(
    (id: string) => {
      const kind = kindById.get(id);
      if (!kind) return;
      setFocus({ id, kind, nonce: ++focusNonce.current });
    },
    [kindById],
  );

  const run = useCallback(
    async (withQuery: string) => {
      const trimmed = withQuery.trim();
      if (trimmed === "") return;
      const token = ++runToken.current;
      setRunning(true);
      const outcome = await rankPlayground({
        projectId,
        query: trimmed,
        ...options,
        drafts: store.getSnapshot(),
      });
      if (token !== runToken.current) return;
      setRunning(false);
      if (outcome.ok) {
        setResult({ response: outcome.data, mode: options.mode, query: trimmed });
        // Dropped alongside the result it stops describing, not while the reader
        // is still typing: the comparison remains true for what is on screen
        // right up to the moment new results replace it.
        if (context && !sameQuery(trimmed, context.query)) {
          setContext(null);
          forgetDeepLink();
        }
        return;
      }
      toast({ title: outcome.error, tone: "danger" });
    },
    [context, options, projectId, store],
  );

  /**
   * Take a prompt from the picker.
   *
   * A prompt offered under "Variants disagreed on these" carries the disagreement
   * it came from, and picking it navigates to that selection rather than
   * running the text on its own. Otherwise the menu promised a comparison and
   * the page then had none, and the same query reached two different screens
   * depending on which door you came through.
   */
  const pickSuggestion = useCallback(
    (suggestion: SuggestedPrompt) => {
      if (suggestion.selectionId) {
        startNavigation(() => {
          router.push(
            playgroundHref(projectId, {
              query: suggestion.text,
              selectionId: suggestion.selectionId,
              experimentName: suggestion.experimentName,
            }),
          );
        });
        return;
      }
      setQuery(suggestion.text);
      void run(suggestion.text);
    },
    [projectId, router, run],
  );

  // Arriving from a Calibration mismatch means the query is already decided, so
  // running it is not a decision the reader needs to make again. The point of
  // the link is to see the comparison. Guarded by a ref rather than a dependency
  // list so it fires once per mount and never re-fires when options change.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !selectionContext || initialQuery.trim() === "") {
      return;
    }
    autoRan.current = true;
    void run(initialQuery);
  }, [initialQuery, run, selectionContext]);

  /**
   * Commit one row's editor buffer.
   *
   * Fired by Save, never while typing. A buffer identical to what is already
   * stored clears the draft instead of writing one: a row that has been opened,
   * looked at and saved unchanged is not an edited row, and leaving an
   * equal-to-saved draft behind would mark it as one forever.
   */
  function handleCommit(
    kind: CapabilityKind,
    id: string,
    description: string,
    tags: string[] | null,
  ) {
    let next = setDraftField(drafts, kind, id, "description", description);
    if (tags !== null) {
      next = setDraftField(next, kind, id, "tags", tags);
    }

    const skill = kind === "skill" ? bench.skills.find((s) => s.name === id) : null;
    const tool = kind === "tool" ? bench.tools.find((t) => t.name === id) : null;
    const unchanged = skill
      ? !skillIsEdited(skill, next.skill[id])
      : tool
        ? !toolIsEdited(tool, next.tool[id])
        : false;

    persist(unchanged ? clearDraft(drafts, kind, id) : next);
  }

  /**
   * Write a skill edit to the catalog, through the existing catalog route: the
   * same optimistic-concurrency PATCH the Catalogs page uses, version guard
   * included. On success the draft is cleared: it has become the saved text,
   * and leaving it would show the row as "edited" against itself.
   *
   * This does NOT publish. A draft skill stays a draft. Publishing decides what
   * every agent retrieves, and this page is where you rehearse a wording,
   * not where that call belongs; Catalogs owns it and shows the whole skill.
   */
  async function handleSaveSkill(skillName: string, description: string | null) {
    const skill = bench.skills.find((candidate) => candidate.name === skillName);
    if (!skill) return;
    const drafted = applySkillDraft(skill, drafts.skill[skillName]);
    setSavingId(skillName);

    const edited = await editSkill(skill.id, {
      expectedVersion: skill.version,
      // Whichever field retrieval reads for this skill, the one the row was editing. Null clears
      // a searchable description, so retrieval falls back to the description.
      ...(skill.searchableDescription === null
        ? { description: (description ?? "").trim() }
        : { searchableDescription: description === null ? null : description.trim() }),
      tags: drafted.tags,
    });
    if (!edited.ok) {
      setSavingId(null);
      toast({
        title:
          edited.reason === "version_conflict"
            ? `“${skillName}” changed since this page loaded. Reload and re-apply your edit.`
            : explainMutationError(edited.status, edited.reason),
        tone: "danger",
      });
      return;
    }

    setSavingId(null);
    // Read the store rather than this render's `drafts`: the editor commits
    // immediately before firing a save, so the closed-over value is one edit
    // behind and clearing from it would resurrect the draft we just wrote.
    persist(clearDraft(store.getSnapshot(), "skill", skillName));
    toast({
      title:
        skill.status === "draft"
          ? `Saved “${skillName}” to the catalog. It is still a draft`
          : `Saved “${skillName}” to the catalog`,
      tone: "success",
    });
    router.refresh();
  }

  /**
   * Write a managed tool's RETRIEVAL description to the catalog.
   *
   * The agent description is deliberately not writable: `tool_definitions` and
   * `catalog_tool_definitions` belong to whoever runs the agent, and no route
   * writes them. What this product does own is the
   * per-project override on the runtime catalog entry, and that endpoint
   * already exists; this only wires the bench to it.
   *
   * There is nothing to invalidate afterwards. This page embeds per run,
   * in-request, so the next run picks the saved text up for free; `router
   * .refresh()` is only here to re-read the bench so the row stops calling
   * itself edited against its own saved value.
   */
  async function handleSaveSearchableDescription(toolName: string, description: string | null) {
    const tool = bench.tools.find((candidate) => candidate.name === toolName);
    if (!tool || tool.entryId === null) return;
    setSavingId(toolName);

    const result = await updateRuntimeCatalogOverride(fetch, {
      projectId,
      kind: "tool",
      // Null is the documented way to CLEAR the override, which is what an
      // emptied field means. Sending "" instead would store an override that
      // matches on nothing.
      searchableDescription: description === null ? null : description.trim(),
      entryId: tool.entryId,
    });
    setSavingId(null);
    if (!result.ok) {
      // The draft is deliberately left in place: the reader's wording is the
      // only copy, and dropping it on a failed request would lose their work.
      toast({ title: result.error, tone: "danger" });
      return;
    }

    persist(clearDraft(store.getSnapshot(), "tool", toolName));
    toast({
      title:
        description === null
          ? `Removed the override for “${toolName}”. Its runtime text applies again`
          : `Saved the searchable description for “${toolName}”`,
      tone: "success",
    });
    router.refresh();
  }

  return (
    <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-4">
      <header className="card-enter flex flex-wrap items-baseline gap-x-2">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-cream">
          Test a search
        </h1>
        <span className="font-mono text-xs text-warm-muted">{projectSlug}</span>
      </header>

      <PromptPanel
        query={query}
        onQueryChange={setQuery}
        suggestions={suggestions}
        options={options}
        onOptionsChange={setOptions}
        onRun={(next) => void run(next)}
        onPickSuggestion={pickSuggestion}
        pending={pending}
        embeddingsEnabled={embeddingsEnabled}
        editCount={editCount}
      />

      <div className="flex min-h-0 flex-col gap-4">
        <ResultsPanel
          response={result?.response ?? null}
          mode={result?.mode ?? options.mode}
          population={{
            skills: bench.skills.length,
            tools: bench.tools.length,
          }}
          pending={pending}
          hasEdits={editCount > 0}
          selectionContext={context}
          kindById={kindById}
          onEdit={focusCapability}
          backHref={
            context?.experimentName
              ? `/project/${projectId}/calibration/${encodeURIComponent(
                  context.experimentName,
                )}/selection/${encodeURIComponent(context.selectionId)}`
              : null
          }
        />
        <CapabilityBench
          skills={skillEntries}
          tools={toolEntries}
          savedDescriptions={savedDescriptions}
          tagsById={tagsById}
          savingId={savingId}
          truncated={bench.truncated}
          focus={focus}
          collapsed={benchCollapsed}
          onCollapsedChange={setBenchCollapsed}
          edits={edits}
          projectSlug={projectSlug}
          onDiscardAll={() => {
            persist(emptyDraftsByKind());
            toast({
              title: `Discarded ${edits.length} unsaved edit${edits.length === 1 ? "" : "s"}`,
              tone: "success",
            });
          }}
          onCommit={handleCommit}
          onRevert={(kind, id) => {
            persist(clearDraft(drafts, kind, id));
            toast({ title: `Discarded your edit to “${id}”`, tone: "success" });
          }}
          onSaveSkill={handleSaveSkill}
          onSaveSearchableDescription={handleSaveSearchableDescription}
          canSaveSearchableDescription={canSaveSearchableDescription}
        />
      </div>
    </div>
  );
}
