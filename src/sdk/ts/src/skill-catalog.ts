import { type Skill, type SkillHit, SkillRegistry } from "../native/index.cjs";
import type { SearchMethod, SearchOrigin, TraceSinkConfig } from "./catalog.js";

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
  private readonly method: SearchMethod;

  constructor(options: SkillCatalogOptions = {}) {
    this.registry = new SkillRegistry();
    this.method = options.method ?? "bm25";
    if (options.trace) {
      this.registry.setTraceSink(options.trace);
    }
  }

  register(skill: Skill): void {
    this.registry.register(skill);
    this.skills.set(skill.id, skill);
  }

  search(
    query: string,
    topK: number,
    origin: SearchOrigin = "direct",
    method?: SearchMethod,
  ): SkillHit[] {
    return this.registry.searchWithMethod(query, topK, origin, method ?? this.method);
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
    this.registry.recordEvent({
      type: "skill_invoke",
      skill_id: skillId,
      took_ms: Date.now() - started,
    });
    return body;
  }
}
