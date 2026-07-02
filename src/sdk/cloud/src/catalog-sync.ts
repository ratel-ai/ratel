import type { Skill, SkillCatalog, TraceSession } from "@ratel-ai/sdk";
import { CloudApiError, CloudAuthError } from "./errors.js";
import type { CloudHttp } from "./http.js";
import type { CatalogResponse, CatalogSkillWire } from "./types.js";

export type FetchCatalogResult =
  | { status: "changed"; etag: string; catalogVersion: string; skills: CatalogSkillWire[] }
  | { status: "unchanged"; etag: string };

export interface SyncResult {
  changed: boolean;
  catalogVersion?: string;
  added: string[];
  updated: string[];
  removed: string[];
  /** Wire ids that collided with host-registered skills — left untouched. */
  conflicts: string[];
}

export interface SkillSyncOptions {
  /** Resync errors land here (and retry next tick); a CloudAuthError also stops the timer. */
  onError?: (err: Error) => void;
  /** Fires once per catalogVersion change — the trace-envelope stamping handoff. */
  onCatalogVersionChange?: (version: string) => void;
  /** When given, `catalog_version` is auto-stamped on this session's envelopes. */
  traceSession?: TraceSession;
}

const DEFAULT_RESYNC_INTERVAL_MS = 60_000;

/** Conditional GET of the published catalog (`ETag` / `If-None-Match`). */
export async function fetchCatalog(http: CloudHttp, etag?: string): Promise<FetchCatalogResult> {
  const response = await http.request("/api/v1/catalog", {
    headers: etag ? { "if-none-match": etag } : {},
  });
  const responseEtag = response.headers.get("etag") ?? "";
  if (response.status === 304) {
    return { status: "unchanged", etag: etag ?? responseEtag };
  }
  if (!response.ok) {
    throw new CloudApiError(`catalog fetch failed (HTTP ${response.status})`, response.status);
  }
  let payload: CatalogResponse;
  try {
    payload = (await response.json()) as CatalogResponse;
  } catch (err) {
    throw new CloudApiError(`catalog fetch returned malformed JSON: ${String(err)}`, 200);
  }
  return {
    status: "changed",
    etag: responseEtag || payload.catalogVersion,
    catalogVersion: payload.catalogVersion,
    skills: payload.skills ?? [],
  };
}

/**
 * Pull/cache sync of a project's published skills into a live `SkillCatalog`
 * (ADR-0014). Cloud is the source of truth ONLY for skills this handle
 * synced: host-registered skills are never clobbered (they surface in
 * `conflicts`), and removal only applies within the synced set.
 */
export class SkillSync {
  private readonly syncedIds = new Set<string>();
  private etag: string | undefined;
  private version: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;

  constructor(
    private readonly http: CloudHttp,
    private readonly catalog: SkillCatalog,
    private readonly opts: SkillSyncOptions = {},
  ) {}

  /** The server's catalogVersion hash from the last applied sync. */
  get catalogVersion(): string | undefined {
    return this.version;
  }

  /** One conditional fetch; applies the diff when the catalog changed. */
  async refresh(): Promise<SyncResult> {
    if (this.refreshing) {
      return { changed: false, added: [], updated: [], removed: [], conflicts: [] };
    }
    this.refreshing = true;
    try {
      const result = await fetchCatalog(this.http, this.etag);
      if (result.status === "unchanged") {
        return { changed: false, added: [], updated: [], removed: [], conflicts: [] };
      }
      this.etag = result.etag;
      const outcome = this.applyDiff(result.skills);
      if (result.catalogVersion !== this.version) {
        this.version = result.catalogVersion;
        this.opts.traceSession?.setCatalogVersion(result.catalogVersion);
        this.opts.onCatalogVersionChange?.(result.catalogVersion);
      }
      return { changed: true, catalogVersion: result.catalogVersion, ...outcome };
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Start periodic resync (default every 60s, ±10% jitter, non-overlapping).
   * Errors go to `onError` and retry next tick; auth rejection stops the
   * timer — a revoked key won't heal on retry.
   */
  start(intervalMs: number = DEFAULT_RESYNC_INTERVAL_MS): void {
    if (this.timer) return;
    const tick = (): void => {
      const jitter = 1 + (Math.random() - 0.5) * 0.2;
      this.timer = setTimeout(async () => {
        try {
          await this.refresh();
        } catch (err) {
          this.opts.onError?.(err as Error);
          if (err instanceof CloudAuthError) {
            this.timer = undefined;
            return;
          }
        }
        if (this.timer) tick();
      }, intervalMs * jitter);
      this.timer.unref?.();
    };
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private applyDiff(
    wireSkills: CatalogSkillWire[],
  ): Omit<SyncResult, "changed" | "catalogVersion"> {
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const conflicts: string[] = [];
    const wireIds = new Set(wireSkills.map((s) => s.id));

    for (const wire of wireSkills) {
      if (this.syncedIds.has(wire.id)) {
        const current = this.catalog.get(wire.id);
        if (!current || !skillsEqual(current, wire)) {
          this.catalog.upsert(wire);
          updated.push(wire.id);
        }
      } else if (this.catalog.has(wire.id)) {
        // Host-local skill with the same id: host-owned, never clobbered.
        conflicts.push(wire.id);
      } else {
        this.catalog.register(wire);
        this.syncedIds.add(wire.id);
        added.push(wire.id);
      }
    }

    for (const id of [...this.syncedIds]) {
      if (!wireIds.has(id)) {
        this.catalog.remove(id);
        this.syncedIds.delete(id);
        removed.push(id);
      }
    }

    return { added, updated, removed, conflicts };
  }
}

/**
 * Field-wise equality between the registered skill and the wire skill, so an
 * idempotent resync emits zero churn. Metadata is compared key-sorted.
 */
function skillsEqual(current: Skill, wire: CatalogSkillWire): boolean {
  return (
    current.name === wire.name &&
    current.description === wire.description &&
    (current.body ?? "") === wire.body &&
    arraysEqual(current.tags ?? [], wire.tags) &&
    arraysEqual(current.tools ?? [], wire.tools) &&
    metadataEqual(current.metadata ?? {}, wire.metadata)
  );
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function metadataEqual(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (!arraysEqual(aKeys, bKeys)) return false;
  return aKeys.every((key) => arraysEqual(a[key] ?? [], b[key] ?? []));
}
