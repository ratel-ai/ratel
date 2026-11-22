"use client";

import { useSyncExternalStore } from "react";

/**
 * Unsaved searchable-description drafts, kept in session storage per project
 * so they survive the in-app navigations a `beforeunload` guard never sees
 * (the rail, "Edit skill", "Show in catalog"). The server and the first
 * client render see no drafts, so hydration always matches; the stored ones
 * arrive right after.
 */

const EMPTY: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; drafts: ReadonlyMap<string, string> }>();

function storageKey(projectId: string): string {
  return `ratel:catalog-drafts:${projectId}`;
}

/** Session storage can be unavailable (private modes, full quota); drafts then live only in memory. */
function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): ReadonlyMap<string, string> {
  if (!raw) return EMPTY;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return EMPTY;
    return new Map(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    // A value written by an older shape of this page: start clean.
    return EMPTY;
  }
}

/** The stored drafts, the same object until they change (what useSyncExternalStore needs). */
export function readDrafts(projectId: string): ReadonlyMap<string, string> {
  const raw = storage()?.getItem(storageKey(projectId)) ?? null;
  const cached = cache.get(projectId);
  if (cached && cached.raw === raw) return cached.drafts;
  const drafts = parse(raw);
  cache.set(projectId, { raw, drafts });
  return drafts;
}

export function writeDrafts(projectId: string, drafts: ReadonlyMap<string, string>): void {
  const store = storage();
  const key = storageKey(projectId);
  const raw = drafts.size === 0 ? null : JSON.stringify(Object.fromEntries(drafts));
  try {
    if (raw === null) store?.removeItem(key);
    else store?.setItem(key, raw);
  } catch {
    // Quota or a blocked store: keep the drafts for this page view only.
  }
  cache.set(projectId, { raw: store ? raw : (cache.get(projectId)?.raw ?? null), drafts });
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The project's drafts, re-rendering when any of them changes. */
export function useStoredDrafts(projectId: string): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    subscribe,
    () => {
      const cached = cache.get(projectId);
      // A blocked store keeps the in-memory copy writeDrafts left behind.
      return storage() ? readDrafts(projectId) : (cached?.drafts ?? EMPTY);
    },
    () => EMPTY,
  );
}
