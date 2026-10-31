"use client";

import { Badge } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { FilterBar, SearchInput } from "@ratel/design-system/filter-bar";
import { EmptyState } from "@ratel/design-system/states";
import { FolderKanban, SearchX } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import {
  filterProjects,
  PROJECT_SEARCH_PARAM,
  type ProjectListItem,
} from "@/lib/console/settings/projects";

/**
 * The organization's projects: a search, then one row per
 * project that opens it. The search updates the URL in place, without a
 * server round trip; the list is already here.
 */
export function ProjectsList({
  projects,
  usage,
  usageNote,
  initialQuery,
  emptyAction,
}: {
  projects: readonly ProjectListItem[];
  /** "2 of 3 projects". */
  usage: string;
  /** Why the count leaves a project out, when it does. */
  usageNote: string | null;
  initialQuery: string;
  /** The first-run action: the New project button. */
  emptyAction: ReactNode;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const rows = useMemo(() => filterProjects(projects, query), [projects, query]);

  function search(next: string) {
    setQuery(next);
    const params = new URLSearchParams(window.location.search);
    if (next.trim()) params.set(PROJECT_SEARCH_PARAM, next);
    else params.delete(PROJECT_SEARCH_PARAM);
    const text = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${text ? `?${text}` : ""}`);
  }

  if (projects.length === 0) {
    return (
      <div className="rounded-lg border border-line">
        <EmptyState
          emblem
          title="No projects yet"
          description="Create the first project to get an API key and start collecting traces."
          action={emptyAction}
        />
      </div>
    );
  }

  const columns: readonly Column<ProjectListItem>[] = [
    {
      id: "name",
      header: "Project",
      cell: (project) => (
        <span className="flex min-w-0 items-center gap-2">
          <Link
            href={project.href}
            className="truncate rounded font-medium text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            {project.name}
          </Link>
          {project.isDemo ? <Badge>Demo</Badge> : null}
        </span>
      ),
    },
    {
      id: "slug",
      header: "Service name",
      width: "16rem",
      cell: (project) => (
        <code translate="no" className="block max-w-60 truncate font-mono text-xs text-fg-muted">
          {project.slug}
        </code>
      ),
    },
    {
      id: "created",
      header: "Created",
      align: "right",
      width: "8rem",
      cell: (project) => (
        <span title={project.createdTitle} className="whitespace-nowrap text-fg-muted">
          {project.created}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <FilterBar
        search={
          <SearchInput
            value={query}
            onValueChange={search}
            placeholder="Search projects…"
            label="Search projects"
          />
        }
        end={
          <span title={usageNote ?? undefined} className="text-xs text-fg-subtle tabular-nums">
            {usage}
          </span>
        }
      />
      <DataTable
        caption="Projects"
        columns={columns}
        rows={rows}
        rowKey={(project) => project.id}
        onRowOpen={(project) => router.push(project.href)}
        empty={
          <EmptyState
            icon={query.trim() ? SearchX : FolderKanban}
            title="No projects match"
            description="Clear the search to see every project."
          />
        }
      />
    </div>
  );
}
