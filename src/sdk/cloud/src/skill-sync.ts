/**
 * Pull-sync of a catalog source into a local `SkillCatalog`. One conditional
 * fetch per refresh; the wire diff is applied under the ownership rule: the
 * sync only ever mutates skills it created, host-registered skills are never
 * touched and surface in `SyncResult.conflicts`.
 */

import type { CatalogSourceConfig, SkillCatalog } from "@ratel-ai/sdk";
import { type CatalogSkillWire, projectSkill, skillsEqual } from "./canonical.js";
import { CloudAuthError } from "./errors.js";
import { fetchCatalog } from "./fetch-catalog.js";

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  /** Wire ids that collided with host-registered skills and were left untouched. */
  conflicts: string[];
  /** True when the source answered 304 — the replica was revalidated as-is. */
  unchanged: boolean;
}

export interface SkillSyncOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

// The chain fires at interval ±10% so a fleet of loaders never thunders in step.
const JITTER = 0.1;

export class SkillSync {
  private readonly catalog: SkillCatalog;
  private readonly config: CatalogSourceConfig;
  private readonly fetchImpl?: typeof fetch;

  /** Cached ETag for this loader's fixed `(url, scope)`. */
  private etag?: string;
  private readonly ownedIds = new Set<string>();
  private inFlight?: Promise<SyncResult>;
  private timer?: ReturnType<typeof setTimeout>;
  private intervalMs?: number;
  private authStopped = false;

  private syncedAt?: Date;
  private failures = 0;

  constructor(catalog: SkillCatalog, config: CatalogSourceConfig, options: SkillSyncOptions = {}) {
    this.catalog = catalog;
    this.config = config;
    if (options.fetchImpl !== undefined) this.fetchImpl = options.fetchImpl;
  }

  get lastSyncedAt(): Date | undefined {
    return this.syncedAt;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  get ownedCount(): number {
    return this.ownedIds.size;
  }

  /** True once the chain has been shut down — permanently so after an auth error. */
  get stopped(): boolean {
    return this.authStopped;
  }

  /** One conditional fetch + diff apply. Concurrent calls coalesce on the in-flight promise. */
  refresh(): Promise<SyncResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<SyncResult> {
    let fetched: Awaited<ReturnType<typeof fetchCatalog>>;
    try {
      const options = this.fetchImpl
        ? { etag: this.etag, fetchImpl: this.fetchImpl }
        : { etag: this.etag };
      fetched = await fetchCatalog(this.config, options);
    } catch (err) {
      this.failures += 1;
      throw err;
    }

    this.failures = 0;
    this.syncedAt = new Date();
    if (!fetched.changed) {
      return { added: 0, updated: 0, removed: 0, conflicts: [], unchanged: true };
    }

    const result = this.applyDiff(fetched.catalog.skills);
    this.etag = fetched.etag;
    return result;
  }

  private applyDiff(wireSkills: CatalogSkillWire[]): SyncResult {
    const result: SyncResult = {
      added: 0,
      updated: 0,
      removed: 0,
      conflicts: [],
      unchanged: false,
    };
    const wireIds = new Set<string>();

    for (const raw of wireSkills) {
      const skill = projectSkill(raw);
      wireIds.add(skill.id);
      if (this.ownedIds.has(skill.id)) {
        const current = this.catalog.get(skill.id);
        if (current === undefined || !skillsEqual(current, skill)) {
          this.catalog.upsert(skill);
          result.updated += 1;
        }
      } else if (this.catalog.has(skill.id)) {
        result.conflicts.push(skill.id);
      } else {
        this.catalog.upsert(skill);
        this.ownedIds.add(skill.id);
        result.added += 1;
      }
    }

    for (const id of [...this.ownedIds]) {
      if (!wireIds.has(id)) {
        this.catalog.remove(id);
        this.ownedIds.delete(id);
        result.removed += 1;
      }
    }

    return result;
  }

  /**
   * Start the periodic refresh chain: a `setTimeout` chain (never
   * `setInterval`) at `intervalMs` ±10% jitter, `unref()`ed so it can't hold
   * the process open. Transient failures keep the chain alive; an auth error
   * stops it permanently.
   */
  start(intervalMs: number): void {
    if (this.timer !== undefined || this.authStopped) return;
    this.intervalMs = intervalMs;
    this.scheduleTick();
  }

  /** Cancel the pending tick. Idempotent. */
  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.intervalMs = undefined;
  }

  // The tick waits the guaranteed minimum (interval − 10%) first and samples
  // the jitter extra (up to +20% of that point) only when the minimum
  // elapses, so each fire draws fresh randomness.
  private scheduleTick(): void {
    const interval = this.intervalMs;
    if (interval === undefined) return;
    this.setTimer(interval * (1 - JITTER), () => {
      const extra = interval * 2 * JITTER * Math.random();
      // Timers clamp sub-1ms delays to 1ms; a zero extra fires in-tick instead.
      if (extra < 1) {
        void this.tick();
      } else {
        this.setTimer(extra, () => void this.tick());
      }
    });
  }

  private setTimer(delay: number, onFire: () => void): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      onFire();
    }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      if (err instanceof CloudAuthError) {
        this.authStopped = true;
        this.stop();
        return;
      }
      // Transient (network / 5xx / unexpected): replica stays live, chain continues.
    }
    this.scheduleTick();
  }
}
