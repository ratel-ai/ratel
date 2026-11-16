"use client";

import { Badge } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { PageBody } from "@ratel/design-system/page-header";
import { usePeek } from "@ratel/design-system/panel";
import { isTypingTarget } from "@ratel/design-system/peek";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import Link from "next/link";
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
import { CapabilityPanel } from "@/components/console/playground/CapabilityPanel";
import { ChangesBar } from "@/components/console/playground/ChangesBar";
import {
  ExperimentNotice,
  type SelectionContext,
} from "@/components/console/playground/ExperimentNotice";
import { FirstRun } from "@/components/console/playground/FirstRun";
import { ResultSection, type ResultView } from "@/components/console/playground/ResultSection";
import { ResultsSkeleton } from "@/components/console/playground/ResultsSkeleton";
import { SearchForm } from "@/components/console/playground/SearchForm";
import { useCatalogSave } from "@/components/console/playground/useCatalogSave";
import { applySkillDraft, skillIsEdited, toolIsEdited } from "@/lib/synthesis/playground/bench";
import {
  buildSkillEntries,
  buildToolEntries,
  ranksById,
  saveAffordance,
} from "@/lib/synthesis/playground/bench-view";
import {
  comparisonColumns,
  type KindById,
  reproducesShadow,
  sameQuery,
} from "@/lib/synthesis/playground/calibration-compare";
import type { Bench } from "@/lib/synthesis/playground/catalog";
import { rankPlayground } from "@/lib/synthesis/playground/client";
import { MAX_BENCH_CAPABILITIES, type RankResponse } from "@/lib/synthesis/playground/contract";
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
import { askTerms, sharedWords } from "@/lib/synthesis/playground/matched-words";
import type { SuggestedPrompt } from "@/lib/synthesis/playground/prompts";
import {
  changeSummary,
  emptyReason,
  resultList,
  verdict,
} from "@/lib/synthesis/playground/result-view";
import type {
  CapabilityKind,
  DraftsByKind,
  RankMode,
  RankOptions,
} from "@/lib/synthesis/playground/types";

const DEFAULT_OPTIONS: RankOptions = {
  mode: "bm25",
  topKSkills: 5,
  topKTools: 5,
  embeddingWeight: 0.5,
};

/** Tools first: a project has a handful of skills and many tools. */
const KIND_ORDER: readonly CapabilityKind[] = ["tool", "skill"];

/** `kind:id`, the form the open Panel and the expected pick take in the URL. */
function parseRef(value: string | null): { kind: CapabilityKind; id: string } | null {
  if (!value) return null;
  const at = value.indexOf(":");
  const kind = value.slice(0, at);
  if (at < 0 || (kind !== "tool" && kind !== "skill")) return null;
  return { kind, id: value.slice(at + 1) };
}

/**
 * Rewrites the address in place: what is searched and what is expected live in
 * the URL (DESIGN.md, Everything is a URL), so refresh and a shared link land on
 * the same search. `replaceState` rather than the router: this is a correction
 * to the address, not a navigation.
 */
function replaceParams(update: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(update)) {
    if (value === null || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState(null, "", url.toString());
}

type PlaygroundWorkbenchProps = {
  projectId: string;
  projectSlug: string;
  bench: Bench;
  initialQuery: string;
  /** `kind:id` of the capability the reader expects first, from the URL. */
  initialExpected: string | null;
  /** List or Compare, when the reader chose one (the URL's `view`). */
  initialView: ResultView | null;
  suggestions: SuggestedPrompt[];
  embeddingsEnabled: boolean;
  /** Whether a managed tool's searchable description can be saved here. The endpoint re-checks. */
  canSaveSearchableDescription: boolean;
  selectionContext: SelectionContext | null;
};

/**
 * Catalog › Test a search. One question: which tools would my agent find for
 * this ask, in what order, and would a different description fix it?
 *
 * Changes to descriptions are a scratchpad kept in this browser (the draft
 * store), so a search can rank them beside the saved catalog without anything
 * leaving the page until the reader saves.
 */
export function PlaygroundWorkbench({
  projectId,
  projectSlug,
  bench,
  initialQuery,
  initialExpected,
  initialView,
  suggestions,
  embeddingsEnabled,
  canSaveSearchableDescription,
  selectionContext,
}: PlaygroundWorkbenchProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [options, setOptions] = useState<RankOptions>(DEFAULT_OPTIONS);
  // A result keeps the settings that produced it, so changing a setting never
  // relabels a finished search.
  const [result, setResult] = useState<{
    response: RankResponse;
    mode: RankMode;
    query: string;
    top: number;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [navigating, startNavigation] = useTransition();
  const pending = running || navigating;
  // Only the newest search may land: a slow one must not overwrite the next.
  const runToken = useRef(0);
  const [context, setContext] = useState(selectionContext);
  const [expected, setExpected] = useState(initialExpected);
  // Null follows the data: Compare when there is a before to show, else the list.
  const [view, setView] = useState<ResultView | null>(initialView);
  const peek = usePeek();

  const store = useMemo(() => createDraftStore(draftsStorageKey(projectId)), [projectId]);
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const persist = useCallback((next: DraftsByKind) => store.set(next), [store]);
  const { savingId, saveSkill, saveTool } = useCatalogSave({
    projectId,
    bench,
    getDrafts: store.getSnapshot,
  });

  const run = result?.response.run ?? null;
  const skillEntries = buildSkillEntries(
    bench.skills,
    drafts,
    ranksById(run?.drafted.skills ?? []),
  );
  const toolEntries = buildToolEntries(bench.tools, drafts, ranksById(run?.drafted.tools ?? []));
  const entriesOf = (kind: CapabilityKind) => (kind === "skill" ? skillEntries : toolEntries);
  const edits = useMemo(() => collectEdits(bench.skills, bench.tools, drafts), [bench, drafts]);
  const editedIds = useMemo(() => new Set(edits.map((edit) => edit.id)), [edits]);
  const kinds = KIND_ORDER.filter(
    (kind) => (kind === "skill" ? bench.skills.length : bench.tools.length) > 0,
  );
  const kindById: KindById = useMemo(
    () =>
      new Map<string, CapabilityKind>([
        ...bench.skills.map((skill) => [skill.name, "skill"] as const),
        ...bench.tools.map((tool) => [tool.name, "tool"] as const),
      ]),
    [bench],
  );
  const savedDescriptions = useMemo(
    () =>
      new Map<string, string>([
        ...bench.skills.map(
          (skill) => [`skill:${skill.name}`, resolveSearchableDescription(skill)] as const,
        ),
        ...bench.tools.map(
          (tool) => [`tool:${tool.name}`, resolveSearchableDescription(tool)] as const,
        ),
      ]),
    [bench],
  );

  const search = useCallback(
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
      if (!outcome.ok) {
        toast({ title: outcome.error, tone: "danger" });
        return;
      }
      setResult({
        response: outcome.data,
        mode: options.mode,
        query: trimmed,
        top: options.topKTools,
      });
      replaceParams({ q: trimmed });
      // The experiment's variants ranked ONE ask. A search for anything else
      // ends that comparison, here and in the address.
      if (context && !sameQuery(trimmed, context.query)) {
        setContext(null);
        replaceParams({ selection: null, experiment: null });
      }
    },
    [context, options, projectId, store],
  );

  // Arriving with an ask (from Quality, an experiment or a shared link) means
  // the search is already decided: run it once, on mount.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || initialQuery.trim() === "") return;
    autoRan.current = true;
    void search(initialQuery);
  }, [initialQuery, search]);

  // "/" jumps to the search field from anywhere on the page, as in any search.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || peek.id) return;
      event.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [peek.id]);

  /** Searches again for what is on screen, so a change is seen the moment it is made. */
  const searchAgain = () => {
    const current = result?.query ?? query;
    if (current.trim() !== "") void search(current);
  };

  const pickSuggestion = (suggestion: SuggestedPrompt) => {
    // An ask the variants disagreed on opens that comparison, not a plain search.
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
    void search(suggestion.text);
  };

  /** Keeps a changed description for the next search; an unchanged one clears its draft. */
  function test(kind: CapabilityKind, id: string, description: string, tags: string[] | null) {
    let next = setDraftField(drafts, kind, id, "description", description);
    if (tags !== null) next = setDraftField(next, kind, id, "tags", tags);
    const skill = kind === "skill" ? bench.skills.find((candidate) => candidate.name === id) : null;
    const tool = kind === "tool" ? bench.tools.find((candidate) => candidate.name === id) : null;
    const unchanged = skill
      ? !skillIsEdited(skill, next.skill[id])
      : tool
        ? !toolIsEdited(tool, next.tool[id])
        : false;
    persist(unchanged ? clearDraft(drafts, kind, id) : next);
    searchAgain();
  }

  function discard(kind: CapabilityKind, id: string) {
    persist(clearDraft(store.getSnapshot(), kind, id));
    searchAgain();
  }

  function discardAll() {
    const previous = store.getSnapshot();
    const count = edits.length;
    persist(emptyDraftsByKind());
    searchAgain();
    toast({
      title: `Discarded ${count} change${count === 1 ? "" : "s"}`,
      action: {
        label: "Undo",
        onClick: () => {
          persist(previous);
          searchAgain();
        },
      },
    });
  }

  async function save(kind: CapabilityKind, id: string, description: string | null) {
    const saved =
      kind === "skill" ? await saveSkill(id, description) : await saveTool(id, description);
    if (!saved) return;
    persist(clearDraft(store.getSnapshot(), kind, id));
    // The bench re-reads, and the search runs on the saved catalog.
    router.refresh();
    searchAgain();
  }

  function expect(kind: CapabilityKind, id: string | null) {
    const value = id === null ? null : `${kind}:${id}`;
    setExpected(value);
    replaceParams({ expect: value });
    if (id === null || !run) return;
    // Naming a tool that is not first is asking "how do I get it there?": open it.
    const rank = resultList(run, kind).rows.find((row) => row.hit.id === id)?.rank;
    if (rank !== 1) peek.open(`${kind}:${id}`);
  }

  // The open Panel.
  const opened = parseRef(peek.id);
  // Kept while the Panel closes, so it does not blank during its exit.
  const [lastOpened, setLastOpened] = useState(opened);
  if (opened && (opened.kind !== lastOpened?.kind || opened.id !== lastOpened?.id))
    setLastOpened(opened);
  const shown = opened ?? lastOpened;
  const shownEntry = shown
    ? (entriesOf(shown.kind).find((entry) => entry.id === shown.id) ?? null)
    : null;
  const shownList = shown && run ? resultList(run, shown.kind) : null;
  const shownIndex = shownList?.rows.findIndex((row) => row.hit.id === shown?.id) ?? -1;
  const step = (direction: 1 | -1) => {
    const next = shownList?.rows[shownIndex + direction];
    if (next && shown) peek.open(`${shown.kind}:${next.hit.id}`);
  };
  const expectedRef = parseRef(expected);
  // Decided once over the whole recording, so both kinds get the same columns:
  // a comparison variant identical to today is the same list twice.
  const collapseShadow =
    context && run ? reproducesShadow(context.arms, run.baseline)?.sameOrder === true : false;
  const terms = askTerms(result?.query ?? "");

  const calibrationBackHref = context?.experimentName
    ? `/project/${projectId}/calibration/${encodeURIComponent(context.experimentName)}/selection/${encodeURIComponent(context.selectionId)}`
    : null;

  return (
    <PageBody>
      {context ? (
        <ExperimentNotice
          context={context}
          saved={run?.baseline ?? null}
          kindById={kindById}
          backHref={calibrationBackHref}
        />
      ) : null}

      <div className="flex flex-col gap-3">
        <SearchForm
          query={query}
          onQueryChange={setQuery}
          onSearch={(next) => void search(next)}
          suggestions={kinds.length > 0 ? suggestions : []}
          onPickSuggestion={pickSuggestion}
          pending={pending}
          options={options}
          onOptionsChange={setOptions}
          embeddingsEnabled={embeddingsEnabled}
          inputRef={inputRef}
          compact={result !== null}
        />
        <ChangesBar
          edits={edits}
          projectSlug={projectSlug}
          onOpen={(id) => peek.open(`${kindById.get(id) ?? "tool"}:${id}`)}
          onDiscardAll={discardAll}
        />
      </div>

      {kinds.length === 0 ? (
        <EmptyState
          emblem
          title="Nothing to search yet"
          description="Tools show up once your agent calls them or your runtime registers them. Skills appear once you create them."
          action={
            <Link
              href={`/project/${projectId}/catalogs`}
              className={buttonVariants({ variant: "secondary" })}
            >
              Open Catalog
            </Link>
          }
        />
      ) : pending ? (
        <ResultsSkeleton rows={Math.min(options.topKTools, 8)} label="Searching your catalog…" />
      ) : !result || !run ? (
        <FirstRun />
      ) : (
        <>
          {result.response.embedding?.local ? (
            <p className="flex items-center gap-2 text-xs text-fg-subtle">
              <Badge tone="warning">Local stand-in</Badge>
              Meaning scores come from a rough local stand-in, not the real model. Development only.
            </p>
          ) : null}
          {kinds.map((kind) => {
            const list = resultList(run, kind);
            // The same search side by side: the experiment's variants while the
            // ask is theirs, then the saved catalog, then the changes.
            const columns = comparisonColumns({
              arms: context && sameQuery(result.query, context.query) ? context.arms : [],
              saved: run.baseline,
              edited: run.hasEdits ? run.drafted : null,
              kind,
              kindById,
              collapseShadow,
            });
            const compare = columns.length > 1 ? columns : null;
            const entries = entriesOf(kind);
            const expectedId = expectedRef?.kind === kind ? expectedRef.id : null;
            const expectedEntry = expectedId
              ? entries.find((entry) => entry.id === expectedId)
              : null;
            return (
              <ResultSection
                key={kind}
                list={list}
                catalogSize={entries.length}
                terms={terms}
                verdict={verdict({
                  list,
                  expected: expectedEntry ? expectedId : null,
                  top: result.top,
                  sharesWords: expectedEntry
                    ? sharedWords(result.query, [expectedEntry.id, expectedEntry.description])
                        .length > 0
                    : true,
                })}
                changes={changeSummary(list, editedIds, expectedEntry ? expectedId : null)}
                emptyReason={emptyReason(list, entries.length, result.mode, embeddingsEnabled)}
                expected={expectedEntry ? expectedId : null}
                onExpect={(id) => expect(kind, id)}
                catalogItems={entries.map((entry) => ({
                  id: entry.id,
                  label: entry.id,
                  hint: entry.rank !== null ? `#${entry.rank}` : undefined,
                  keywords: [entry.description],
                }))}
                onOpen={(id) => {
                  if (kindById.has(id)) peek.open(`${kind}:${id}`);
                }}
                openId={opened?.kind === kind ? opened.id : null}
                compare={compare}
                // Compare whenever there is a before to show, unless the reader chose the list.
                view={compare ? (view ?? "compare") : "list"}
                onViewChange={(next) => {
                  setView(next);
                  replaceParams({ view: next });
                }}
              />
            );
          })}
          {bench.truncated.tools || bench.truncated.skills ? (
            <p className="text-xs text-fg-subtle">
              Your catalog is larger than {MAX_BENCH_CAPABILITIES} per kind; this search covers the
              first {MAX_BENCH_CAPABILITIES}.
            </p>
          ) : null}
        </>
      )}

      <CapabilityPanel
        open={opened !== null}
        onOpenChange={(open) => {
          if (!open) peek.close();
        }}
        entry={shownEntry}
        savedDescription={shown ? (savedDescriptions.get(`${shown.kind}:${shown.id}`) ?? "") : ""}
        savedTags={
          shown?.kind === "skill"
            ? (() => {
                const skill = bench.skills.find((candidate) => candidate.name === shown.id);
                return skill ? applySkillDraft(skill, drafts.skill[skill.name]).tags : [];
              })()
            : null
        }
        search={
          result && shown
            ? {
                query: result.query,
                mode: result.mode,
                top: result.top,
                row: shownList?.rows[shownIndex] ?? null,
              }
            : null
        }
        saveAffordance={
          shownEntry
            ? saveAffordance(shownEntry, { canSaveSearchableDescription })
            : { kind: "blocked", reason: "" }
        }
        saving={shown !== null && savingId === shown.id}
        onTest={(description, tags) => shown && test(shown.kind, shown.id, description, tags)}
        onDiscard={() => shown && discard(shown.kind, shown.id)}
        onSave={(description) => shown && void save(shown.kind, shown.id, description)}
        onPrevious={shownIndex > 0 ? () => step(-1) : undefined}
        onNext={
          shownIndex >= 0 && shownList && shownIndex < shownList.rows.length - 1
            ? () => step(1)
            : undefined
        }
      />
    </PageBody>
  );
}
