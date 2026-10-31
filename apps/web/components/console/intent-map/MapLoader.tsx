"use client";

import { lazy, Suspense, useSyncExternalStore } from "react";

/** Loaded on first use: the loader's animation runtime ships its own stylesheet. */
const DotLoader = lazy(() =>
  import("@ratel/design-system/dot-matrix").then((module) => ({ default: module.DotLoader })),
);

const noSubscription = () => () => {};

/**
 * The section loader for the map and the flow, drawn in the browser only. The
 * drawing itself only exists there, so the server has nothing to wait on, and
 * keeping the loader out of the server render keeps its stylesheet out of
 * every module that renders the map (tests included).
 */
export function MapLoader({ label }: { label: string }) {
  const inBrowser = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  if (!inBrowser) return null;
  return (
    <Suspense fallback={null}>
      <DotLoader label={label} />
    </Suspense>
  );
}
