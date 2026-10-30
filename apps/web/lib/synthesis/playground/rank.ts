import { SkillCatalog, ToolRegistry } from "@ratel-ai/sdk";
import {
  type DescribedCapability,
  resolveSearchableDescription,
  type SearchableDescriptionSource,
  searchableDescriptionSource,
} from "./descriptions";
import { blendScores, cosineSimilarity, normalizeWithinBucket, rankIds } from "./scoring";
import type {
  BenchSkill,
  BenchTool,
  CapabilityKind,
  RankedBuckets,
  RankedHit,
  RankOptions,
} from "./types";

/**
 * The Playground's ranking seam.
 *
 * BM25 scoring runs through `@ratel-ai/sdk`'s OWN registries (the native
 * BM25 an agent actually retrieves with) rather than a reimplementation: a
 * second scorer would quietly disagree with production and the whole surface
 * exists to be trusted. That also means this file is the single place to touch when the
 * engine ships a new ranking behavior; bumping `@ratel-ai/sdk` is enough for
 * the Playground to follow.
 *
 * Skills and tools are ranked in independent buckets with independent top-K
 * budgets, mirroring `searchCapabilitiesTool`.
 */

/** Vectors for an embeddings or hybrid run, keyed by capability id. */
export interface EmbeddingVectors {
  query: number[];
  skills: ReadonlyMap<string, number[]>;
  tools: ReadonlyMap<string, number[]>;
}

export interface RankInput {
  query: string;
  /** Draft-applied skills. This module never folds drafts itself. */
  skills: readonly BenchSkill[];
  /** Draft-applied tools. */
  tools: readonly BenchTool[];
  editedSkillIds: ReadonlySet<string>;
  editedToolIds: ReadonlySet<string>;
  options: RankOptions;
  /** Required by the `embeddings` and `hybrid` modes; ignored by `bm25`. */
  vectors?: EmbeddingVectors;
}

/**
 * The text a capability is matched on, used for embedding. Mirrors what the
 * native registries index (identity, prose, and author labels) so both sides of
 * a hybrid run are reading the same capability, not two different summaries.
 *
 * The prose here is the RETRIEVAL description, not the agent description. Those
 * are the same string in most projects, but where they differ the runtime
 * matches on the retrieval one — so embedding the other would score the bench
 * against text no agent is ever ranked on.
 */
export function capabilityIndexText(
  capability: DescribedCapability & { name: string; tags?: readonly string[] },
): string {
  const tags = capability.tags ?? [];
  return [capability.name, resolveSearchableDescription(capability), tags.join(", ")]
    .filter((part) => part.trim() !== "")
    .join("\n");
}

/**
 * The SDK tags an emitted search event with where the search came from. It does
 * NOT change ranking, verified against the native registries: same query and
 * same results under both values. It is pinned here rather than exposed as
 * a knob. The Playground stands in for agent-side retrieval, hence "agent".
 */
const SEARCH_ORIGIN = "agent";

/** BM25 scores for every skill, from the SDK's own index. Non-matches absent. */
function skillBm25Scores(query: string, skills: readonly BenchSkill[]): Map<string, number> {
  const catalog = new SkillCatalog();
  for (const skill of skills) {
    catalog.register({
      id: skill.name,
      name: skill.name,
      // The searchable description, for the same reason `capabilityIndexText`
      // uses it: BM25 and the embedding pass have to index the same text or a
      // hybrid run blends two different readings of one capability.
      description: resolveSearchableDescription(skill),
      tags: skill.tags,
      tools: skill.tools,
      metadata: {},
      body: "",
    });
  }
  const scores = new Map<string, number>();
  if (skills.length === 0) return scores;
  for (const hit of catalog.search(query, skills.length, SEARCH_ORIGIN)) {
    scores.set(hit.skillId, hit.score);
  }
  return scores;
}

/**
 * BM25 scores for every tool. Uses the native `ToolRegistry` rather than the
 * SDK's `ToolCatalog` because the catalog only accepts executable tools, and a
 * cloud-side what-if has nothing to execute. The registry is the same index
 * without that requirement.
 */
function toolBm25Scores(query: string, tools: readonly BenchTool[]): Map<string, number> {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register({
      id: tool.name,
      name: tool.name,
      description: resolveSearchableDescription(tool),
      // Observed tools carry no synced schema; an open object keeps the shape
      // valid without asserting parameters we do not actually know.
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
  }
  const scores = new Map<string, number>();
  if (tools.length === 0) return scores;
  for (const hit of registry.searchWithOrigin(query, tools.length, SEARCH_ORIGIN)) {
    scores.set(hit.toolId, hit.score);
  }
  return scores;
}

function embeddingScores(
  queryVector: readonly number[],
  vectors: ReadonlyMap<string, number[]>,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [id, vector] of vectors) {
    scores.set(id, cosineSimilarity(queryVector, vector));
  }
  return scores;
}

/** What a hit carries back: the two texts, kept apart on purpose. */
interface HitText {
  /** What the agent receives. */
  description: string;
  /** What the prompt was matched against. */
  searchableDescription: string;
  searchableDescriptionSource: SearchableDescriptionSource;
}

interface BucketInput {
  kind: CapabilityKind;
  ids: readonly string[];
  texts: ReadonlyMap<string, HitText>;
  edited: ReadonlySet<string>;
  bm25: ReadonlyMap<string, number>;
  embeddings: ReadonlyMap<string, number> | null;
  topK: number;
  options: RankOptions;
}

function rankBucket({
  kind,
  ids,
  texts,
  edited,
  bm25,
  embeddings,
  topK,
  options,
}: BucketInput): RankedHit[] {
  // BM25-only keeps the index's own result set: a zero there means the query and
  // the description share no terms at all, which is a real "not retrievable"
  // answer and not a weak match worth listing.
  const scored =
    options.mode === "bm25"
      ? new Map(bm25)
      : embeddings === null
        ? new Map<string, number>()
        : options.mode === "embeddings"
          ? new Map(embeddings)
          : blendScores(
              normalizeWithinBucket(new Map(ids.map((id) => [id, bm25.get(id) ?? 0]))),
              normalizeWithinBucket(embeddings),
              options.embeddingWeight,
            );

  return rankIds(scored)
    .slice(0, topK)
    .map((id, index) => ({
      id,
      kind,
      rank: index + 1,
      score: scored.get(id) ?? 0,
      bm25Score: bm25.get(id) ?? 0,
      embeddingScore: embeddings?.get(id) ?? null,
      description: texts.get(id)?.description ?? "",
      searchableDescription: texts.get(id)?.searchableDescription ?? "",
      searchableDescriptionSource: texts.get(id)?.searchableDescriptionSource ?? "description",
      edited: edited.has(id),
    }));
}

/** Rank one query against a drafted catalog, in two independent buckets. */
export function rankCapabilities(input: RankInput): RankedBuckets {
  const { query, skills, tools, options, vectors } = input;
  const needsVectors = options.mode !== "bm25";
  if (needsVectors && !vectors) {
    throw new Error(`rankCapabilities: ${options.mode} mode requires vectors`);
  }

  return {
    skills: rankBucket({
      kind: "skill",
      ids: skills.map((skill) => skill.name),
      texts: new Map(skills.map((skill) => [skill.name, hitText(skill)])),
      edited: input.editedSkillIds,
      bm25: skillBm25Scores(query, skills),
      embeddings: vectors && needsVectors ? embeddingScores(vectors.query, vectors.skills) : null,
      topK: options.topKSkills,
      options,
    }),
    tools: rankBucket({
      kind: "tool",
      ids: tools.map((tool) => tool.name),
      texts: new Map(tools.map((tool) => [tool.name, hitText(tool)])),
      edited: input.editedToolIds,
      bm25: toolBm25Scores(query, tools),
      embeddings: vectors && needsVectors ? embeddingScores(vectors.query, vectors.tools) : null,
      topK: options.topKTools,
      options,
    }),
  };
}

/**
 * Both readings of one capability, for the payload.
 *
 * `description` stays the agent description even when the match came from
 * somewhere else: the whole point of ranking on the retrieval text is that what
 * the agent RECEIVES is a different field, and a hit that reported the matched
 * text as its description would hide exactly the discrepancy this surface
 * exists to reveal.
 */
function hitText(capability: BenchSkill | BenchTool): HitText {
  return {
    description: capability.description,
    searchableDescription: resolveSearchableDescription(capability),
    searchableDescriptionSource: searchableDescriptionSource(capability),
  };
}
