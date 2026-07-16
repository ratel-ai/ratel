import type { SkillCatalog } from "./skill-catalog.js";

/**
 * The lifecycle contract a catalog loader implements — the formal seam over
 * the mutable-catalog surface ({@link SkillCatalog.upsert} / `remove` /
 * `onChange`, ADR-0003). A loader is any separate package that mirrors a source
 * (a directory of SKILL.md files, the managed cloud, a DB, git) into a catalog:
 * it *owns its sync loop* and drives the catalog itself. This contract is only
 * the lifecycle the SDK starts and stops; there is no SDK-owned snapshot
 * diffing.
 *
 * Every method may be synchronous or asynchronous — {@link attachLoader}
 * absorbs both by awaiting the return. `SkillCatalog` (protocol/v1 is
 * skills-only) is the sole catalog type a loader hydrates.
 */
export interface CatalogLoader {
  /**
   * Hydrate the catalog with one synchronous pass over the source, then begin
   * owning the loop (a watcher, a poll, or nothing for a one-shot loader).
   * Resolves when the initial hydration is done — {@link attachLoader} awaits
   * it, so its caller gets a hydrated-or-failed catalog.
   *
   * @param catalog - The catalog to mirror the source into.
   */
  start(catalog: SkillCatalog): void | Promise<void>;
  /**
   * End the loop and release any resource `start` acquired. The loader must be
   * restartable afterwards (detach-then-reattach is supported). Hydrated skills
   * stay in the catalog by design (ADR-0003 offline semantics).
   */
  stop(): void | Promise<void>;
  /**
   * Run one sync pass now — the same pass `start` runs first. A watch-only
   * loader may no-op it. Required (not optional) so the contract stays a single
   * structural type with no `refresh?.()` conditionals at the call sites.
   */
  refresh(): void | Promise<void>;
}

/** What {@link attachLoader} returns: the loop's off switch and a manual sync trigger. */
export interface CatalogLoaderHandle {
  /**
   * Stop the loader and detach it (calls {@link CatalogLoader.stop} once).
   * Idempotent — safe to call from a shutdown path that may also run
   * elsewhere; a second call is a no-op. After detach the loader instance is
   * re-attachable.
   */
  detach(): Promise<void>;
  /** Trigger one {@link CatalogLoader.refresh} pass now; a pass-through. */
  refresh(): Promise<void>;
}

// A loader instance is single-attach: attaching it a second time while already
// running is a caller bug (two loops writing one catalog). The catalog itself
// stays loader-blind — this bookkeeping lives here, keyed weakly so a
// forgotten-but-detached loader is still collectable.
const attached = new WeakSet<CatalogLoader>();

/**
 * Attach a {@link CatalogLoader} to a {@link SkillCatalog}: call the loader's
 * `start(catalog)` and resolve once it has hydrated (or reject if it throws).
 * A free function, mirroring {@link registerMcpServer} — the catalog never
 * learns about loaders.
 *
 * Attaching the *same loader instance* twice while it is running rejects
 * loudly. `detach` then a fresh `attachLoader` is the supported way to
 * re-run one. A `start` failure leaves any already-committed upserts in place
 * (each was individually committed and notified — there is no diff to roll
 * back) and re-allows attaching. **No telemetry in v1** (deferred to the Cloud
 * loader, ADR-0003).
 *
 * @param catalog - Catalog the loader hydrates and keeps in sync.
 * @param loader - The loader to start and own.
 * @returns A handle to `detach` (stop the loop) or `refresh` (one pass now).
 *
 * @example
 * ```ts
 * import { attachLoader, SkillCatalog } from "@ratel-ai/sdk";
 * import { LocalSkillsLoader } from "@ratel-ai/local-skills";
 *
 * const catalog = new SkillCatalog();
 * const handle = await attachLoader(catalog, new LocalSkillsLoader());
 * // ... catalog now holds ~/.ratel/skills ...
 * await handle.refresh(); // pick up on-disk edits
 * await handle.detach();  // stop; the last-synced skills survive
 * ```
 */
export async function attachLoader(
  catalog: SkillCatalog,
  loader: CatalogLoader,
): Promise<CatalogLoaderHandle> {
  if (attached.has(loader)) {
    throw new Error("loader already attached; detach it before attaching again");
  }
  attached.add(loader);
  try {
    await loader.start(catalog);
  } catch (err) {
    // Hydration failed: re-allow attaching. Partial upserts stay — each was
    // committed and notified on its own; the SDK has no snapshot to unwind.
    attached.delete(loader);
    throw err;
  }

  let detached = false;
  return {
    detach: async () => {
      if (detached) {
        return;
      }
      // Mark detached and free the guard first, so a `stop` that throws still
      // leaves the loader re-attachable and this handle a no-op on re-entry.
      detached = true;
      attached.delete(loader);
      await loader.stop();
    },
    refresh: async () => {
      await loader.refresh();
    },
  };
}
