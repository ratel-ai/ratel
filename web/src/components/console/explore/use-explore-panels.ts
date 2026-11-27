"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefusedField } from "@/components/console/dashboards/WidgetFields";
import { useTraceNavigation } from "@/components/console/traces/navigation";
import { filtersProblem, shownFilters } from "@/lib/views/dashboards/filters";
import type { DashboardFilters, WidgetInput } from "@/lib/views/dashboards/types";
import { canonicalJson, queryFilter } from "@/lib/views/dashboards/widget";
import {
  panelProblem,
  panelsOfAddress,
  stateOfAddress,
  withoutFragment,
  withPanels,
} from "@/lib/views/explore/state";

const ADDRESS_DELAY_MS = 250;

export interface ExplorePanel {
  /** Of this page only. */
  id: string;
  widget: WidgetInput;
}

/** A change that was not made, and the field it was made in. */
export interface RefusedChange {
  panelId: string;
  field: RefusedField;
  message: string;
}

type Shown = { panels: readonly ExplorePanel[]; problem: string | null };

/**
 * The panels: edited here, and written to the address a moment later without a request. A change
 * that an address cannot hold is refused, so the two are always the same. The address wins when it
 * changes otherwise (back, forward, a link to the page).
 */
export function useExplorePanels(
  initial: readonly WidgetInput[],
  problem: string | null,
  /** A new value each time the server answered. */
  served: unknown,
) {
  const { search, pending, go: navigate, replaceView } = useTraceNavigation();
  const nextId = useRef(initial.length);
  const [shown, setShown] = useState<Shown>(() => ({
    panels: initial.map((widget, index) => ({ id: `panel-${index}`, widget })),
    problem,
  }));
  const [refused, setRefused] = useState<RefusedChange | null>(null);
  const current = useRef(shown);
  // The address that the filters of the page are in, also while its answer is on the way.
  const bar = useRef(search);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The panels of the last navigation of this page, which may land after another edit.
  const carried = useRef<string | null>(null);

  const show = useCallback((next: Shown) => {
    current.current = next;
    setShown(next);
  }, []);
  const write = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const { panels, problem: shownProblem } = current.current;
    if (shownProblem === null && panels.length > 0)
      replaceView(withPanels(window.location.search, widgetsOf(current.current)));
  }, [replaceView]);

  const readAddress = useCallback(() => {
    if (timer.current) return;
    const { search: address, hash } = window.location;
    bar.current = address;
    // The range of the address is the server's to read, and to refuse.
    if (problem !== null) return show({ panels: [], problem });
    const decoded = panelsOfAddress(address, hash);
    if (!decoded) return;
    if (!decoded.ok) return show({ panels: [], problem: decoded.error });
    const unfit = filtersProblem(
      decoded.panels.map(({ query }) => query),
      shownFilters(address, {}),
    );
    if (unfit) return show({ panels: [], problem: unfit });
    const own = widgetsOf(current.current);
    if (current.current.problem === null && canonicalJson(decoded.panels) === canonicalJson(own))
      return;
    if (carried.current !== null && stateOfAddress(address, hash) === carried.current)
      return write();
    setRefused(null);
    show({
      panels: decoded.panels.map((widget) => ({ id: `panel-${nextId.current++}`, widget })),
      problem: null,
    });
  }, [problem, show, write]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: an answer of the server is the signal.
  useEffect(readAddress, [served, readAddress]);
  useEffect(() => {
    const flush = () => {
      if (timer.current) write();
    };
    window.addEventListener("popstate", readAddress);
    window.addEventListener("hashchange", readAddress);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("popstate", readAddress);
      window.removeEventListener("hashchange", readAddress);
      window.removeEventListener("beforeunload", flush);
      clearTimeout(timer.current);
    };
  }, [readAddress, write]);

  const setPanels = useCallback(
    (change: (panels: readonly ExplorePanel[]) => readonly ExplorePanel[]) => {
      const before = current.current.panels;
      const panels = change(before);
      const refusal = refusalOf(before, panels, shownFilters(bar.current, {}));
      setRefused(refusal);
      if (refusal) return;
      show({ panels, problem: null });
      clearTimeout(timer.current);
      timer.current = setTimeout(write, ADDRESS_DELAY_MS);
    },
    [show, write],
  );
  const newPanel = useCallback(
    (widget: WidgetInput): ExplorePanel => ({ id: `panel-${nextId.current++}`, widget }),
    [],
  );
  /** A change of the filters or the range: a request, with the panels as they are now. */
  const go = useCallback(
    (change: (current: string) => string) => {
      write();
      navigate((address) => {
        const next = withoutFragment(change(withoutFragment(address)));
        bar.current = next;
        if (current.current.problem !== null) return next;
        const to = withPanels(next, widgetsOf(current.current));
        const [path, hash = ""] = to.split("#");
        carried.current = stateOfAddress(path, `#${hash}`);
        return to;
      });
    },
    [navigate, write],
  );

  return { ...shown, search, pending, go, setPanels, newPanel, refused };
}

function widgetsOf({ panels }: Shown): WidgetInput[] {
  return panels.map(({ widget }) => widget);
}

/** The first changed panel that an address cannot hold. */
function refusalOf(
  before: readonly ExplorePanel[],
  after: readonly ExplorePanel[],
  filters: DashboardFilters,
): RefusedChange | null {
  for (const { id, widget } of after) {
    const old = before.find((panel) => panel.id === id)?.widget;
    const message =
      widget === old ? null : (filtersProblem([widget.query], filters) ?? panelProblem(widget));
    if (message) return { panelId: id, field: changedField(old, widget), message };
  }
  return null;
}

function changedField(old: WidgetInput | undefined, widget: WidgetInput): RefusedField {
  if (old && old.title !== widget.title) return "title";
  const filters = (query: WidgetInput["query"]) => canonicalJson(queryFilter(query));
  return old && filters(old.query) !== filters(widget.query) ? "filter" : "query";
}
