import {
  activeNavItemId,
  commandEntries,
  consoleNav,
  type NavItem,
  organizationRoot,
  projectRoot,
} from "@/lib/console/navigation";
import { searchCommands } from "@/lib/console/scope/command-search";
import {
  COMMAND_QUERIES,
  NAV_SCOPES,
  type NavScope,
  ORGANIZATION_PATHS,
  ORGANIZATION_SLUG,
  PROJECT_ID,
  PROJECT_PATHS,
} from "./inputs";
import { control, parity } from "./ledger";
import { commandHrefs, commands, type RailRow, rail, railId } from "./normalise";
import { golden, same } from "./support";

// Items 8 and 18: the navigation model. The rail, ⌘K and the highlighted item are pure functions
// of the scope on both sides, so the same scopes, paths and queries go in and the answers compare.

interface CloudShell {
  rail: RailRow[];
  active: Record<string, string | null>;
  commands: { id: string; label: string; group: string; href: string; keywords?: string[] }[];
  search: Record<string, { id: string; href: string }[]>;
}
const cloud = golden<Record<NavScope, CloudShell>>("navigation");

/** This repository's shell for a scope: the rail, its root and what ⌘K searches. */
function shell(scope: NavScope) {
  const inProject = scope !== "organization";
  const items = consoleNav({
    projectId: inProject ? PROJECT_ID : undefined,
    organizationSlug: ORGANIZATION_SLUG,
    additions: [],
    stageSpine: scope === "project+stageSpine",
  });
  const root = inProject ? projectRoot(PROJECT_ID) : organizationRoot(ORGANIZATION_SLUG);
  const entries = commandEntries({
    items,
    organizationItems: inProject
      ? consoleNav({ projectId: undefined, organizationSlug: ORGANIZATION_SLUG, additions: [] })
      : [],
    projectId: inProject ? PROJECT_ID : undefined,
    projects: [],
    pathname: root,
    organizationSlug: ORGANIZATION_SLUG,
  });
  return { items, root, entries, paths: inProject ? PROJECT_PATHS : ORGANIZATION_PATHS };
}

/** A rail item as a row, with Cloud's fields. */
function rows(items: readonly NavItem[]): RailRow[] {
  const row = (item: NavItem, extra: Partial<RailRow>): RailRow => {
    return {
      id: item.id,
      label: item.label,
      href: item.href,
      ...(item.exact ? { exact: true } : {}),
      ...(item.also ? { also: item.also } : {}),
      ...(item.shortcut ? { shortcut: item.shortcut } : {}),
      ...(item.keywords ? { keywords: item.keywords } : {}),
      ...(item.activeId ? { activeId: item.activeId } : {}),
      ...extra,
    };
  };
  return items.flatMap((item) => [
    row(item, item.sectionLabel ? { sectionLabel: item.sectionLabel } : {}),
    ...(item.children ?? []).map((child) => row(child, { parent: item.id })),
  ]);
}

const withoutKeywords = (list: RailRow[]) => list.map(({ keywords: _keywords, ...row }) => row);
const keywordsOf = (list: RailRow[]) =>
  Object.fromEntries(list.map((row) => [row.id, row.keywords ?? null]));

for (const scope of NAV_SCOPES) {
  const here = shell(scope);
  const cloudRail = rail("cloud", cloud[scope].rail);
  const hereRail = rail("oss", rows(here.items));
  const active = () =>
    Object.fromEntries(
      here.paths.map((path) => [
        path,
        railId("oss", activeNavItemId(`${here.root}${path}`, here.items)),
      ]),
    );

  if (scope === "organization") {
    control(`the ${scope} rail has Cloud's items`, () => {
      same(withoutKeywords(hereRail), withoutKeywords(cloudRail));
    });
    control(`the ${scope} rail highlights the item Cloud highlights`, () => {
      same(active(), cloud[scope].active);
    });
  } else {
    parity(18, `the ${scope} rail has Cloud's items, with the paths each absorbs`, () => {
      same(withoutKeywords(hereRail), withoutKeywords(cloudRail));
    });
    parity(18, `the ${scope} rail highlights the item Cloud highlights, path by path`, () => {
      same(active(), cloud[scope].active);
    });
  }

  parity(8, `the ${scope} rail items carry Cloud's search keywords`, () => {
    same(keywordsOf(hereRail), keywordsOf(cloudRail));
  });
  parity(8, `⌘K in the ${scope} shell lists Cloud's entries`, () => {
    same(commands(here.entries), commands(cloud[scope].commands));
  });
  parity(8, `⌘K in the ${scope} shell finds what Cloud finds, query by query`, () => {
    const found = Object.fromEntries(
      COMMAND_QUERIES.map((query) => [
        query,
        commandHrefs(searchCommands(here.entries, query).slice(0, 40)),
      ]),
    );
    const expected = Object.fromEntries(
      COMMAND_QUERIES.map((query) => [query, commandHrefs(cloud[scope].search[query])]),
    );
    same(found, expected);
  });
}
