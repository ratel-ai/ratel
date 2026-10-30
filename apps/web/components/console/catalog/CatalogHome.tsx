"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { CodeBlock } from "@ratel/design-system/code";
import { SearchInput } from "@ratel/design-system/filter-bar";
import { EmptyState } from "@ratel/design-system/states";
import { expandableIds, treePath } from "@ratel/design-system/tree-model";
import { SearchX } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { ITEM_PARAM, itemKey, parseItemKey } from "@/lib/console/catalog/item-id";
import type { SkillsCatalogData, ToolsCatalogData } from "@/lib/console/catalog/load";
import { TOOL_CATALOG_SNIPPET } from "@/lib/console/catalog/sync-snippet";
import {
  buildCatalogTree,
  catalogTreeEntry,
  filterCatalogTree,
  initialExpanded,
  integrationOf,
  searchExpanded,
} from "@/lib/console/catalog/tree";
import { CatalogItemDetail } from "./CatalogItemDetail";
import { CatalogTree } from "./CatalogTree";
import { SkillActions } from "./SkillActions";
import { fetchSkillBody } from "./skill-body";
import { useCatalogStore } from "./use-catalog-store";
import { useSearchParamState, useUrlParam } from "./use-url-param";

/**
 * The Catalog home: every tool and skill as a tree on the left, the picked
 * one on the right. The pick lives in `?item=` and the search in `?q=`; which
 * branches are open is the reader's own and stays local.
 */
export function CatalogHome({
  projectId,
  now,
  tools,
  skills,
}: {
  projectId: string;
  now: string;
  tools: ToolsCatalogData;
  skills: SkillsCatalogData;
}) {
  const store = useCatalogStore({ projectId, tools, skills });
  const items = useMemo(
    () => [...store.toolItems, ...store.skillItems],
    [store.toolItems, store.skillItems],
  );
  const byKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);
  const tree = useMemo(() => buildCatalogTree(items.map(catalogTreeEntry)), [items]);

  const [itemParam, setItemParam] = useUrlParam(ITEM_PARAM);
  const [query, setQuery] = useSearchParamState("q");
  const ref = parseItemKey(itemParam);
  const selectedKey = ref ? itemKey(ref.kind, ref.id) : null;
  const selected = selectedKey ? (byKey.get(selectedKey) ?? null) : null;

  const [expanded, setExpanded] = useState(() => initialExpanded(tree, selectedKey));
  const [closedWhileSearching, setClosedWhileSearching] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const searching = query.trim() !== "";
  const visibleTree = useMemo(() => filterCatalogTree(tree, query), [tree, query]);
  const open = useMemo(
    () => (searching ? searchExpanded(visibleTree, closedWhileSearching) : expanded),
    [searching, visibleTree, closedWhileSearching, expanded],
  );
  const detail = useRef<HTMLDivElement>(null);

  // Keep the picked item in view when it moves (a skill published into another
  // group) or arrives through the URL (Back, a shared link). Adjusted while
  // rendering, not in an effect, so the tree never paints with it hidden.
  const selectedPath = useMemo(
    () => (selectedKey ? (treePath(tree, selectedKey)?.join("\n") ?? null) : null),
    [tree, selectedKey],
  );
  const [revealedPath, setRevealedPath] = useState(selectedPath);
  if (selectedPath !== revealedPath) {
    setRevealedPath(selectedPath);
    const ids = selectedPath ? selectedPath.split("\n") : [];
    if (!ids.every((id) => expanded.has(id))) setExpanded(new Set([...expanded, ...ids]));
  }

  function select(key: string) {
    setItemParam(key);
    // Stacked on a narrow screen, the detail sits below the tree: bring it up.
    if (window.matchMedia("(max-width: 1023px)").matches) {
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      detail.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    }
  }

  function search(next: string) {
    setQuery(next);
    setClosedWhileSearching(new Set());
  }

  function changeExpanded(next: Set<string>) {
    if (!searching) {
      setExpanded(next);
      return;
    }
    // While searching every match is open; remember what the reader closes.
    setClosedWhileSearching(new Set(expandableIds(visibleTree).filter((id) => !next.has(id))));
  }

  const empty = items.length === 0;
  const skillsHref = `/project/${encodeURIComponent(projectId)}/catalogs/skills`;

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <aside
        aria-label="Tools and skills"
        className="flex min-h-0 flex-col border-line max-lg:border-b lg:w-80 lg:shrink-0 lg:border-r"
      >
        <div className="border-b border-line p-3">
          <SearchInput
            value={query}
            onValueChange={search}
            placeholder="Search tools and skills…"
            label="Search tools and skills"
            className="max-w-none"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 max-lg:max-h-[55dvh]">
          {empty ? (
            <p className="px-2 py-3 text-ui text-fg-subtle">No tools or skills yet.</p>
          ) : visibleTree.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="No items match"
              description="Try another word, or clear the search."
              action={
                <Button size="sm" onClick={() => search("")}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <CatalogTree
              nodes={visibleTree}
              expanded={open}
              onExpandedChange={changeExpanded}
              selectedKey={selectedKey}
              onSelect={select}
            />
          )}
        </div>
      </aside>

      <section
        ref={detail}
        aria-label="Item detail"
        className="min-w-0 flex-1 scroll-mt-12 lg:overflow-y-auto"
      >
        <div className="max-w-4xl px-6 py-6 lg:px-8">
          {selected ? (
            <CatalogItemDetail
              item={selected}
              now={now}
              layout="pane"
              groupLabel={integrationOf(tree, selected.key)}
              adopted={{ tool: tools.adopted, skill: skills.adopted }}
              onSaveSearchable={store.saveSearchable}
              onResetSearchable={store.resetSearchable}
              draft={store.drafts.get(selected.key) ?? null}
              onDraftChange={(item, draft) => store.setDraft(item.key, draft)}
              loadSkillBody={skills.bodiesIncluded ? undefined : fetchSkillBody}
              actions={
                selected.kind === "skill" ? (
                  <SkillActions
                    item={selected}
                    onTransition={(item, transition) =>
                      void store.transitionSkill(item, transition)
                    }
                    editHref={
                      selected.record
                        ? `${skillsHref}?peek=${encodeURIComponent(selected.record.id)}&edit=1`
                        : undefined
                    }
                  />
                ) : null
              }
            />
          ) : selectedKey ? (
            <EmptyState
              icon={SearchX}
              title="This item is not in the catalog"
              description="It may have been renamed or removed since the link was made."
              action={
                <Button size="sm" onClick={() => setItemParam(null)}>
                  Clear selection
                </Button>
              }
            />
          ) : empty ? (
            <div className="flex flex-col gap-4">
              <EmptyState
                emblem
                title="Nothing in your catalog yet"
                description="Tools show up once your agent calls them or your runtime registers them. Skills are written here."
                action={
                  <Link
                    href={`${skillsHref}?new=1`}
                    className={buttonVariants({ variant: "secondary" })}
                  >
                    New skill
                  </Link>
                }
              />
              {tools.syncGuide ? (
                <CodeBlock
                  caption="Register tools with the SDK"
                  samples={[{ label: "TypeScript", code: TOOL_CATALOG_SNIPPET }]}
                  className="mx-auto w-full max-w-2xl"
                />
              ) : null}
            </div>
          ) : (
            <EmptyState
              emblem
              title="Pick a tool or skill to see how it is found"
              className="py-24"
            />
          )}
        </div>
      </section>
    </div>
  );
}
