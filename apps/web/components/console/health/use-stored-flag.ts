"use client";

import { useSyncExternalStore } from "react";

/**
 * A per-viewer on/off setting kept in localStorage. Storage can be missing or
 * blocked (a private window, cleared site data), so every read and write is
 * guarded; a setting never stored reads as `fallback`, and the server always
 * renders `fallback`.
 */

const CHANGE = "ratel:stored-flag";
/** Values set while storage is unavailable, so a setting still holds until the page reloads. */
const memory = new Map<string, boolean>();

/** The stored value, or `fallback` when nothing is stored or storage is unavailable. */
export function readStoredFlag(key: string, fallback = false): boolean {
  try {
    const value = window.localStorage.getItem(key);
    if (value !== null) return value === "1";
  } catch {
    // Storage is unavailable: fall through to what this page set.
  }
  return memory.get(key) ?? fallback;
}

/** Stores the value and tells every reader on the page. Returns false when storage refused it. */
export function writeStoredFlag(key: string, value: boolean): boolean {
  let stored = true;
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Storage is unavailable: the setting lasts until the page reloads.
    stored = false;
  }
  window.dispatchEvent(new Event(CHANGE));
  return stored;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE, onChange);
  };
}

export function useStoredFlag(key: string, fallback = false): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readStoredFlag(key, fallback),
    () => fallback,
  );
  return [value, (next: boolean) => void writeStoredFlag(key, next)];
}
