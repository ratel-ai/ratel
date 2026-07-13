import { SearchTarget } from "@ratel-ai/telemetry";
import {
  type EmbeddingConfig as NativeEmbeddingConfig,
  type Skill,
  type SkillHit,
  SkillRegistry,
} from "../native/index.cjs";
import type { EmbeddingSpec, SearchMethod, SearchOrigin, TraceSinkConfig } from "./catalog.js";
import { traceSearch, traceSkillLoad } from "./telemetry.js";

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
   * {@link ToolCatalogOptions.embedding}. Ignored (with a warning) for `"bm25"`. */
  embedding?: EmbeddingSpec;
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
  private readonly eager: boolean;

  /**
   * Create an empty catalog.
   *
   * @param options - Trace sink and default retrieval method. A `"semantic"`/
   *   `"hybrid"` default makes every subsequent `register` embed the new skill
   *   immediately (loading the embedding model on first use); the `"bm25"`
   *   default stays model-free.
   */
  constructor(options: SkillCatalogOptions = {}) {
    this.method = options.method ?? "bm25";
    this.eager = this.method === "semantic" || this.method === "hybrid";
    if (options.embedding && !this.eager) {
      console.warn(
        'ratel: `embedding` was provided but method is "bm25", which needs no model — the embedding config is ignored',
      );
    }
    this.registry = new SkillRegistry(
      this.eager && options.embedding ? toNativeEmbedding(options.embedding) : undefined,
    );
    if (options.trace) {
      this.registry.setTraceSink(options.trace);
    }
  }

  /**
   * Add a skill to the catalog, or replace it in place when the id is already
   * registered. Name, description, and tags are indexed for ranking; the
   * `body` is not (it is the dispatch payload, fetched by
   * {@link SkillCatalog.invoke}). On a semantic/hybrid catalog this also
   * embeds the new skill immediately, and throws if the embedding model fails
   * to load.
   *
   * @param skill - The skill to register; `id` is its lookup key.
   */
  register(skill: Skill): void {
    this.registry.register(skill);
    this.skills.set(skill.id, skill);
    if (this.eager) {
      this.registry.buildEmbeddings();
    }
  }

  /** Pre-compute embeddings for not-yet-embedded skills. See `ToolCatalog.buildEmbeddings`. */
  buildEmbeddings(): void {
    this.registry.buildEmbeddings();
  }

  /**
   * Search the catalog — the skill counterpart of `ToolCatalog.search`, with
   * the same method semantics (a `"semantic"`/`"hybrid"` call throws
   * `EmbeddingsNotBuilt` if the embedding cache isn't built).
   *
   * @param query - Natural-language description of the task at hand.
   * @param topK - Maximum number of hits to return.
   * @param origin - Who initiated the call (default `"direct"`); recorded on
   *   the trace event and span, never affects ranking.
   * @param method - Per-call override of the catalog's default retrieval method.
   * @returns Up to `topK` hits, best-first with ties broken by skill id; the
   *   `score` scale depends on the method (BM25 / cosine / RRF).
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
