import { SearchTarget } from "@ratel-ai/telemetry";
import { type Skill, type SkillHit, SkillRegistry } from "../native/index.cjs";
import type { SearchMethod, SearchOrigin, TraceSinkConfig } from "./catalog.js";
import { traceSearch, traceSkillLoad } from "./telemetry.js";

export type { Skill, SkillHit };

export interface SkillCatalogOptions {
  trace?: TraceSinkConfig;
  /** Default retrieval method for `search` (default `"bm25"`). */
  method?: SearchMethod;
}

/**
 * In-memory catalog of skills, ranked by the native BM25 `SkillRegistry`. The
 * on-demand analog of {@link ToolCatalog}: registered skills are searched by
 * relevance; the matching body is fetched only on {@link SkillCatalog.invoke}.
 */
export class SkillCatalog {
  private readonly registry: SkillRegistry;
  private readonly skills = new Map<string, Skill>();
  private readonly changeListeners = new Set<() => void>();
  private readonly method: SearchMethod;
  private readonly eager: boolean;

  constructor(options: SkillCatalogOptions = {}) {
    this.registry = new SkillRegistry();
    this.method = options.method ?? "bm25";
    this.eager = this.method === "semantic" || this.method === "hybrid";
    if (options.trace) {
      this.registry.setTraceSink(options.trace);
    }
  }

  register(skill: Skill): void {
    this.registry.register(skill);
    this.skills.set(skill.id, skill);
    if (this.eager) {
      this.registry.buildEmbeddings();
    }
    this.notifyChange();
  }

  /**
   * Register-or-replace by id. Returns `true` when an existing skill was
   * replaced. The path catalog sync uses to hot-reload a changed skill.
   */
  upsert(skill: Skill): boolean {
    const replaced = this.registry.upsert(skill);
    this.skills.set(skill.id, skill);
    if (this.eager) {
      this.registry.buildEmbeddings();
    }
    this.notifyChange();
    return replaced;
  }

  /** Remove a skill by id. Returns `true` when something was removed. */
  remove(skillId: string): boolean {
    const removed = this.registry.remove(skillId);
    this.skills.delete(skillId);
    if (removed) {
      if (this.eager) {
        this.registry.buildEmbeddings();
      }
      this.notifyChange();
    }
    return removed;
  }

  /**
   * Subscribe to catalog mutations (register/upsert/remove). Returns an
   * unsubscribe function. The staleness hook for anything that caches a view
   * of the catalog, e.g. `tools/list_changed` notifications.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        // A broken subscriber must not break the mutation or its siblings.
      }
    }
  }

  /** Pre-compute embeddings for not-yet-embedded skills. See `ToolCatalog.buildEmbeddings`. */
  buildEmbeddings(): void {
    this.registry.buildEmbeddings();
  }

  search(
    query: string,
    topK: number,
    origin: SearchOrigin = "direct",
    method?: SearchMethod,
  ): SkillHit[] {
    return traceSearch(SearchTarget.Skill, query, topK, origin, () =>
      this.registry.searchWithMethod(query, topK, origin, method ?? this.method),
    );
  }

  has(skillId: string): boolean {
    return this.skills.has(skillId);
  }

  get(skillId: string): Skill | undefined {
    return this.skills.get(skillId);
  }

  size(): number {
    return this.skills.size;
  }

  recordEvent(event: object): void {
    this.registry.recordEvent(event);
  }

  drainTraceEvents(): unknown[] {
    return this.registry.drainTraceEvents();
  }

  /**
   * Return a skill's body for dispatch, recording a `skill_invoke` event.
   * Throws on an unknown id — callers at the capability-tool boundary translate that
   * into a structured error for the agent.
   */
  invoke(skillId: string): string {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`unknown skillId: ${skillId}`);
    }
    return traceSkillLoad(skillId, () => {
      const started = Date.now();
      const body = skill.body ?? "";
      this.registry.recordEvent({
        type: "skill_invoke",
        skill_id: skillId,
        took_ms: Date.now() - started,
      });
      return body;
    });
  }
}
