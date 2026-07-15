import { SearchTarget } from "@ratel-ai/telemetry";
import {
  type EmbeddingConfig as NativeEmbeddingConfig,
  type Skill,
  type SkillHit,
  SkillRegistry,
} from "../native/index.cjs";
import type { EmbeddingSpec, SearchMethod, SearchOrigin, TraceSinkConfig } from "./catalog.js";
import { traceSearch, traceSearchAsync, traceSkillLoad } from "./telemetry.js";

export type { Skill, SkillHit };

function toNativeEmbedding(embedding: EmbeddingSpec): NativeEmbeddingConfig {
  return typeof embedding === "string" ? { spec: embedding } : embedding;
}

/** Construction options for {@link SkillCatalog}. */
export interface SkillCatalogOptions {
  /** Local trace stream destination (default: discard). See {@link TraceSinkConfig}. */
  trace?: TraceSinkConfig;
  /** Default retrieval method for `search` (default `"bm25"`). */
  method?: SearchMethod;
  /** Embedding model for semantic/hybrid retrieval — see
   * {@link ToolCatalogOptions.embedding}. Retained for asynchronous overrides. */
  embedding?: EmbeddingSpec;
}

/**
 * In-memory catalog of skills, ranked by the native `SkillRegistry` retrieval
 * engine. The on-demand analog of {@link ToolCatalog}: registered skills are
 * searched by relevance; the matching body is fetched only on
 * {@link SkillCatalog.invoke}.
 */
export class SkillCatalog {
  private readonly registry: SkillRegistry;
  private readonly skills = new Map<string, Skill>();
  private readonly method: SearchMethod;

  /**
   * Create an empty catalog.
   *
   * @param options - Trace sink, default retrieval method, and embedding model.
   *   Construction validates configuration but never loads a model.
   */
  constructor(options: SkillCatalogOptions = {}) {
    this.method = options.method ?? "bm25";
    this.registry = new SkillRegistry(
      options.embedding !== undefined ? toNativeEmbedding(options.embedding) : undefined,
    );
    if (options.trace) {
      this.registry.setTraceSink(options.trace);
    }
  }

  /**
   * Add a skill to the catalog, or replace it in place when the id is already
   * registered. Name, description, and tags are indexed for ranking; the
   * `body` is not (it is the dispatch payload, fetched by
   * {@link SkillCatalog.invoke}). Registration is metadata-only.
   *
   * @param skill - The skill to register; `id` is its lookup key.
   */
  register(skill: Skill): void {
    this.registry.register(skill);
    this.skills.set(skill.id, skill);
  }

  /** Add or replace a batch of skills without building embeddings. */
  registerMany(skills: readonly Skill[]): void {
    this.registry.registerMany([...skills]);
    for (const skill of skills) this.skills.set(skill.id, skill);
  }

  /** Pre-compute embeddings for not-yet-embedded skills. See `ToolCatalog.buildEmbeddings`. */
  buildEmbeddings(): Promise<void> {
    return this.registry.buildEmbeddings();
  }

  /** Recompute the full corpus and atomically replace the dense cache. */
  rebuildEmbeddings(): Promise<void> {
    return this.registry.rebuildEmbeddings();
  }

  /**
   * Search the catalog synchronously with BM25. A `"semantic"`/`"hybrid"`
   * call throws synchronously with guidance to use
   * {@link SkillCatalog.searchAsync}.
   *
   * @param query - Natural-language description of the task at hand.
   * @param topK - Maximum number of hits to return.
   * @param origin - Who initiated the call (default `"direct"`); recorded on
   *   the trace event and span, never affects ranking.
   * @param method - Per-call override of the catalog's default retrieval method.
   * @returns Up to `topK` BM25 hits, best-first with ties broken by skill id.
   *   Semantic/dense/hybrid methods throw migration guidance; use
   *   {@link SkillCatalog.searchAsync} for those methods.
   */
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

  /** Search with any retrieval method without blocking the Node.js event loop. */
  searchAsync(
    query: string,
    topK: number,
    origin: SearchOrigin = "direct",
    method?: SearchMethod,
  ): Promise<SkillHit[]> {
    return traceSearchAsync(SearchTarget.Skill, query, topK, origin, () =>
      this.registry.searchWithMethodAsync(query, topK, origin, method ?? this.method),
    );
  }

  /**
   * Whether a skill with this id is registered.
   *
   * @param skillId - The id to look up.
   * @returns `true` if {@link SkillCatalog.invoke} would find it.
   */
  has(skillId: string): boolean {
    return this.skills.has(skillId);
  }

  /**
   * Look up a skill by id.
   *
   * @param skillId - The id to look up.
   * @returns The skill as registered (including `body`), or `undefined` for an
   *   unknown id.
   */
  get(skillId: string): Skill | undefined {
    return this.skills.get(skillId);
  }

  /**
   * Number of registered skills (distinct ids). `searchCapabilitiesTool` uses
   * this to decide whether to advertise a `skills` bucket at all.
   *
   * @returns The count.
   */
  size(): number {
    return this.skills.size;
  }

  /**
   * Record a custom event on the local trace stream (ADR-0007). Same contract
   * as `ToolCatalog.recordEvent`: the event is a tagged wire-shape object
   * (`{ type: "...", ... }`, snake_case fields) and an unknown shape throws.
   *
   * @param event - The trace event to record.
   */
  recordEvent(event: object): void {
    this.registry.recordEvent(event);
  }

  /**
   * Drain the envelopes captured by a `"memory"` trace sink, emptying its
   * buffer. Same contract as `ToolCatalog.drainTraceEvents`.
   *
   * @returns The captured envelopes in record order; `[]` unless the active
   *   sink is `"memory"`.
   */
  drainTraceEvents(): unknown[] {
    return this.registry.drainTraceEvents();
  }

  /**
   * Return a skill's body for dispatch, recording a `skill_invoke` event.
   * Throws on an unknown id — callers at the capability-tool boundary translate that
   * into a structured error for the agent.
   *
   * @param skillId - Id of a registered skill.
   * @returns The skill's `body` (`""` when it was registered without one).
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
