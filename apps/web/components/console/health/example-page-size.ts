"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_EXAMPLE_PAGE_SIZE,
  EXAMPLE_PAGE_SIZE_STORAGE_KEY,
  type ExamplePageSize,
  parseExamplePageSize,
} from "@/components/console/health/card-model";

/**
 * How many example turns a viewer likes to see at once, remembered in their
 * own browser and shared by every problem on the page, so picking "5" on one
 * card sets it everywhere.
 *
 * Storage can be missing or throw (a private window, blocked site data). The
 * choice then lives in memory for the rest of the visit, and the page renders
 * the default without it; nothing depends on it being saved.
 */

const listeners = new Set<() => void>();

/** The choice made on this visit; wins over storage, and covers it when storage is off. */
let visitChoice: ExamplePageSize | null = null;

function readStored(): ExamplePageSize {
  try {
    return parseExamplePageSize(window.localStorage.getItem(EXAMPLE_PAGE_SIZE_STORAGE_KEY));
  } catch {
    // Storage is off for this viewer; the default stands in.
    return DEFAULT_EXAMPLE_PAGE_SIZE;
  }
}

function getSnapshot(): ExamplePageSize {
  return visitChoice ?? readStored();
}

function getServerSnapshot(): ExamplePageSize {
  return DEFAULT_EXAMPLE_PAGE_SIZE;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab changed it: follow along.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== EXAMPLE_PAGE_SIZE_STORAGE_KEY) return;
    visitChoice = null;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function writeChoice(size: ExamplePageSize): void {
  visitChoice = size;
  try {
    window.localStorage.setItem(EXAMPLE_PAGE_SIZE_STORAGE_KEY, String(size));
  } catch {
    // Storage is off: the choice still holds for this visit through `visitChoice`.
  }
  for (const listener of listeners) listener();
}

export function useExamplePageSize(): [ExamplePageSize, (size: ExamplePageSize) => void] {
  const size = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const set = useCallback((next: ExamplePageSize) => writeChoice(next), []);
  return [size, set];
}
