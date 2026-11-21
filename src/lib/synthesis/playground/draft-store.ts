import { emptyDraftsByKind, parseStoredDrafts } from "./drafts";
import type { DraftsByKind } from "./types";

/**
 * A `useSyncExternalStore`-shaped view over the bench's localStorage drafts.
 *
 * Drafts are external state that the server cannot see, so reading them in an
 * effect and calling setState would both cascade a render and risk a hydration
 * mismatch. Modelling them as an external store instead gives React an explicit
 * server snapshot (always empty, since the server has no drafts) and lets it swap in
 * the stored value after hydration.
 *
 * `getSnapshot` must be referentially stable between writes: re-parsing storage
 * on every call would hand React a new object each render and loop forever, so
 * the parsed value is cached and only invalidated on a write or a cross-tab
 * `storage` event.
 */

export interface DraftStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): DraftsByKind;
  getServerSnapshot(): DraftsByKind;
  set(next: DraftsByKind): void;
}

/** Shared frozen value, so the server snapshot is stable across calls. */
const SERVER_SNAPSHOT: DraftsByKind = emptyDraftsByKind();

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createDraftStore(
  key: string,
  storage: DraftStorage | null = typeof window === "undefined" ? null : window.localStorage,
): DraftStore {
  let cached: DraftsByKind | null = null;
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      // A second tab editing the same project should not silently diverge.
      const onStorage = (event: StorageEvent) => {
        if (event.key !== null && event.key !== key) return;
        cached = null;
        notify();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
      };
    },
    getSnapshot() {
      if (cached === null) {
        let raw: string | null = null;
        try {
          raw = storage?.getItem(key) ?? null;
        } catch {
          // Storage can be blocked outright (private mode, hardened settings).
          // The bench still works; drafts just do not survive a reload.
        }
        cached = parseStoredDrafts(raw);
      }
      return cached;
    },
    getServerSnapshot() {
      return SERVER_SNAPSHOT;
    },
    set(next) {
      cached = next;
      try {
        storage?.setItem(key, JSON.stringify(next));
      } catch {
        // A full or blocked quota must not break the bench mid-edit.
      }
      notify();
    },
  };
}
