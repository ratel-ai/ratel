import { SearchTarget } from "@ratel-ai/telemetry";
import { type Skill, type SkillHit, SkillRegistry } from "../native/index.cjs";
import type { SearchMethod, SearchOrigin, TraceSinkConfig } from "./catalog.js";
import { traceSearch, traceSkillLoad } from "./telemetry.js";

export type { Skill, SkillHit };

/** Construction options for {@link SkillCatalog}. */
export interface SkillCatalogOptions {
  /** Local trace stream destination (default: discard). See {@link TraceSinkConfig}. */
  trace?: TraceSinkConfig;
  /** Default retrieval method for `search` (default `"bm25"`). */
  method?: SearchMethod;
}

/**
 * In-memory catalog of skills, ranked by the native BM25 `SkillRegistry`. The
 * on-demand analog of {@link ToolCatalog}: registered skills are searched by
 * relevance; the matching body is fetched only on {@link SkillCatalog.invoke}.
 *
 * The catalog is mutable at runtime — the loader-facing seam: an external
 * loader (any package holding a catalog and mirroring a source into it) pushes
 * with {@link SkillCatalog.upsert}, drops with {@link SkillCatalog.remove},
 * and the host observes churn via {@link SkillCatalog.onChange}.
 */
export class SkillCatalog {
  private readonly registry: SkillRegistry;
  private readonly skills = new Map<string, Skill>();
  private readonly method: SearchMethod;
  private readonly eager: boolean;
  private readonly listeners = new Set<() => void>();

  /**
   * Create an empty catalog.
   *
   * @param options - Trace sink and default retrieval method. A `"semantic"`/
   *   `"hybrid"` default makes every subsequent `register` embed the new skill
   *   immediately (loading the embedding model on first use); the `"bm25"`
   *   default stays model-free.
   */
  constructor(options: SkillCatalogOptions = {}) {
    this.registry = new SkillRegistry();
    this.method = options.method ?? "bm25";
    this.eager = this.method === "semantic" || this.method === "hybrid";
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
    this.notifyChange();
  }

  /**
   * {@link SkillCatalog.register} that also reports whether the id was already
   * present — the added-vs-replaced signal an external loader needs to mirror
   * a source into the catalog. Same replace-in-place, eager-embedding, and
   * change-notification behavior as `register`.
   *
   * @param skill - The skill to add or replace; `id` is its lookup key.
   * @returns `true` when an already-registered id was replaced, `false` when
   *   the skill is new.
   */
  upsert(skill: Skill): boolean {
    const replaced = this.skills.has(skill.id);
    this.register(skill);
    return replaced;
  }

  /**
   * Remove a skill by id. The index entry and its cached embedding drop
   * together, so a semantic/hybrid catalog keeps searching with no rebuild.
   * Notifies {@link SkillCatalog.onChange} subscribers on a hit; an unknown id
   * is a silent no-op (no notification).
   *
   * @param skillId - Id of the skill to remove.
   * @returns `true` when the id was present, `false` otherwise.
   */
  remove(skillId: string): boolean {
    const removed = this.registry.remove(skillId);
    this.skills.delete(skillId);
    if (removed) {
      this.notifyChange();
    }
    return removed;
  }

  /**
   * Subscribe to catalog churn: the listener fires after every mutation —
   * `register`, `upsert`, and a `remove` that hit. It is a low-level signal
   * (an initial registration burst fires it per skill; debouncing is the
   * subscriber's job) and the single staleness hook for hosts: re-emit
   * `tools/list_changed` from it, and if the `search_capabilities` description
   * was cached, re-read it on an empty↔non-empty transition. A listener that
   * throws is swallowed — it breaks neither the mutation nor other listeners.
   * Subscribing the same function twice keeps one subscription.
   *
   * @param listener - Called (with no arguments) after each mutation.
   * @returns An unsubscribe function; call it to stop the notifications.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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

  /** Fire every subscriber over a snapshot; a throwing one is isolated. */
  private notifyChange(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A bad subscriber must not break the mutation or its siblings.
      }
    }
  }
}
