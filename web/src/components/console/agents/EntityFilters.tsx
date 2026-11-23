"use client";

import { SearchInput } from "@ratel/design-system/filter-bar";
import { Select } from "@ratel/design-system/select";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { DateRangeControl } from "@/components/console/calibration/DateRangeControl";
import { AGENTS_ENVIRONMENT_PARAM } from "@/lib/views/agents/paths";
import type { EntityFilterState } from "./EntityParts";

/** "All environments": an option value no real environment uses. */
const ALL = "__all__";

/**
 * The filter row of the Agents and MCP servers lists (the approved RP-25 design): search on the
 * left, then the environment (the parameter Traces reads, kept in the URL so the server re-reads)
 * and the page's own controls, and `end` on the right.
 */
export function EntityFilters({
  search,
  onSearch,
  placeholder,
  filters,
  children,
  end,
}: {
  search: string;
  onSearch: (value: string) => void;
  placeholder: string;
  filters: EntityFilterState;
  children?: ReactNode;
  end?: ReactNode;
}) {
  return (
    <div role="toolbar" aria-label="Filters" className="flex flex-wrap items-center gap-2">
      <SearchInput value={search} onValueChange={onSearch} placeholder={placeholder} />
      <EnvironmentSelect filters={filters} />
      {children}
      {end ? <div className="ml-auto flex items-center gap-2">{end}</div> : null}
    </div>
  );
}

/** The environment control; absent when the window has no environment. */
export function EnvironmentSelect({ filters }: { filters: EntityFilterState }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { environments, environment } = filters;
  // A filtered environment the window no longer has stays selectable, so the reader can clear it.
  const values =
    environment && !environments.includes(environment)
      ? [...environments, environment]
      : environments;
  if (values.length === 0) return null;

  function setEnvironment(next: string) {
    const query = new URLSearchParams(params.toString());
    if (next === ALL) query.delete(AGENTS_ENVIRONMENT_PARAM);
    else query.set(AGENTS_ENVIRONMENT_PARAM, next);
    const search = query.toString();
    router.push(search ? `${pathname}?${search}` : pathname);
  }

  return (
    <Select
      aria-label="Environment"
      className="w-auto"
      value={environment ?? ALL}
      onValueChange={setEnvironment}
      options={[
        { value: ALL, label: "Environment: all" },
        ...values.map((value) => ({ value, label: `Environment: ${value}` })),
      ]}
    />
  );
}

/** The window, in the page header's actions. */
export function WindowControl({ filters }: { filters: EntityFilterState }) {
  return (
    <DateRangeControl
      preset={filters.range.preset}
      from={filters.range.from}
      to={filters.range.to}
      alignPicker="end"
      unified
    />
  );
}
