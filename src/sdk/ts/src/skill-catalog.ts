import { type Skill, type SkillHit, SkillRegistry, type TraceSession } from "../native/index.cjs";
import type { SearchOrigin, TraceSinkConfig } from "./catalog.js";

export type { Skill, SkillHit };

export interface SkillCatalogOptions {
  trace?: TraceSinkConfig;
  /** Shared session buffer — see `ToolCatalogOptions.traceSession`. */
  traceSession?: TraceSession;
}

export interface TracedSkillSearch {
  /** Id stamped on the emitted event — attributed to later invokes. */
  searchId: string;
  hits: SkillHit[];
}

/**
 * In-memory catalog of skills, ranked by the native BM25 `SkillRegistry`. The
 * on-demand analog of {@link ToolCatalog}: registered skills are searched by
 * relevance; the matching body is fetched only on {@link SkillCatalog.invoke}.
 */
export class SkillCatalog {
  private readonly registry: SkillRegistry;
  private readonly skills = new Map<string, Skill>();
  /** skill id → id of the most recent search that surfaced it (ADR-0013). */
  private readonly lastSearchIdBySkill = new Map<string, string>();
  private readonly changeListeners = new Set<() => void>();

  constructor(options: SkillCatalogOptions = {}) {
    this.registry = new SkillRegistry();
    if (options.traceSession) {
      this.registry.attachTraceSession(options.traceSession);
    } else if (options.trace) {
      this.registry.setTraceSink(options.trace);
    }
  }

  register(skill: Skill): void {
    this.registry.register(skill);
    this.skills.set(skill.id, skill);
    this.notifyChange();
  }

  /**
   * Register-or-replace by id. Returns `true` when an existing skill was
   * replaced. The path catalog sync uses to hot-reload a changed skill.
   */
  upsert(skill: Skill): boolean {
    const replaced = this.registry.upsert(skill);
    this.skills.set(skill.id, skill);
    this.notifyChange();
    return replaced;
  }

  /** Remove a skill by id. Returns `true` when something was removed. */
  remove(skillId: string): boolean {
    const removed = this.registry.remove(skillId);
    this.skills.delete(skillId);
    this.lastSearchIdBySkill.delete(skillId);
    if (removed) this.notifyChange();
    return removed;
  }

  /**
   * Subscribe to catalog mutations (register/upsert/remove). Returns an
   * unsubscribe function. The staleness hook for MCP `tools/list_changed`
   * notifications and other cache invalidation.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  search(query: string, topK: number, origin: SearchOrigin = "direct"): SkillHit[] {
    return this.searchTraced(query, topK, origin).hits;
  }

  /** Like {@link search}, but also returns the emitted event's `search_id`. */
  searchTraced(query: string, topK: number, origin: SearchOrigin = "direct"): TracedSkillSearch {
    const outcome = this.registry.searchWithTrace(query, topK, origin);
    for (const hit of outcome.hits) {
      this.lastSearchIdBySkill.set(hit.skillId, outcome.searchId);
    }
    return outcome;
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
   * Throws on an unknown id — callers at the gateway boundary translate that
   * into a structured error for the agent.
   */
  invoke(skillId: string): string {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`unknown skillId: ${skillId}`);
    }
    const started = Date.now();
    const body = skill.body ?? "";
    const searchId = this.lastSearchIdBySkill.get(skillId);
    this.registry.recordEvent({
      type: "skill_invoke",
      skill_id: skillId,
      took_ms: Date.now() - started,
      ...(searchId ? { search_id: searchId } : {}),
    });
    return body;
  }
}
