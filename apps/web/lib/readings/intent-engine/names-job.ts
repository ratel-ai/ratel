import Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray, sql } from "drizzle-orm";
import { envNumber } from "@/lib/platform/env-number";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import { configured } from "@/lib/readings/decisions/engine";
import type { ActionKey } from "@/lib/readings/intent-engine/actions";
import {
  buildNamesPrompt,
  NAMES_KEYS_SCHEMA,
  NAMES_SCHEMA,
  type NamedLevel,
  type NameInput,
  type NameVocabulary,
  nameHash,
  namePhrases,
  type ParsedName,
  parseNames,
} from "@/lib/readings/intent-engine/names";
import { intentClusters } from "@/lib/readings/intent-engine/schema";
import { boundEngineTransaction, type EngineDb } from "@/lib/readings/intent-engine/store";
import type { EngineCluster, LevelTree } from "@/lib/readings/intent-types/engine-types";
import { DEFAULT_LABEL_MODEL } from "@/lib/readings/model-defaults";

/**
 * The model-naming step of an engine run: "What they ask for" (level 1) gets a
 * written name, and with model keys on the query clusters (level 0) get a name
 * and a key in the same call.
 *
 * Spend is set by env and keys alone: no call without `ANTHROPIC_API_KEY`, at
 * most `INTENT_ENGINE_MAX_NAMES` clusters per run (0 turns naming off), and one
 * naming pass per project per {@link NAME_INTERVAL_MS}. The default cap is one
 * batch, so a project costs at most one call an hour (two more when a batch is
 * cut off and retried in halves). Candidates come from the run's own clusters
 * and hierarchy, in memory: a node is named again only when the phrases it
 * stands for change (the phrase hash), never on every ask it gains, and a
 * written name stands until its new one is in. Names never written stay
 * rule-based.
 *
 * Every failure is logged and reported, then counted: a reply cut off at
 * `max_tokens`, a refusal, a failed call and an unusable reply each have their
 * own count in the run's result and its `intent_engine_named` event.
 *
 * The asks are captured content the customer chose to send. They go to the
 * model as quoted data inside tags, never as instructions.
 */

/** Clusters one run names when `INTENT_ENGINE_MAX_NAMES` is unset: one batch, so one call. */
export const DEFAULT_MAX_NAMES = 20;
/** Clusters per call. */
export const NAME_BATCH = 20;
/** Room for the model's thinking and a batch of names, as the topics namer allows. */
const NAME_MAX_TOKENS = 16_000;
/**
 * One call's wait and its one retry: a stuck call never holds the run near the
 * job reaper's ten minutes (three batches at most, two tries each).
 */
const NAME_TIMEOUT_MS = 60_000;
const NAME_MAX_RETRIES = 1;
/** A project's clusters are named at most this often. */
export const NAME_INTERVAL_MS = 60 * 60_000;
const logger = getLogger("intent-engine/names");

/** One model call; `keyed` asks for the schema that carries a query cluster's action and object too. */
export type NamesComplete = (system: string, user: string, keyed: boolean) => Promise<string>;

/** The model stopped at `max_tokens`: the batch's reply was cut off. */
export class NamesCutOffError extends Error {
  constructor() {
    super("cluster names cut off at the token limit");
    this.name = "NamesCutOffError";
  }
}

/** The model declined the batch (`stop_reason: "refusal"`). */
export class NamesDeclinedError extends Error {
  constructor() {
    super("cluster names declined by the model's safety filter");
    this.name = "NamesDeclinedError";
  }
}

/** With model keys on: what the model may key with, and how its answer is read. */
export interface NameKeys {
  vocabulary: NameVocabulary;
  parse: (raw: { action?: unknown; object?: unknown }) => ActionKey | null;
}

export interface NameJobDeps {
  model: string;
  complete: NamesComplete | null;
  maxNames: number;
  /** Absent or null: names only. */
  keys?: NameKeys | null;
}

export interface NameJobResult {
  candidates: number;
  named: number;
  /** Query clusters that got a usable key this run. */
  keyedClusters: number;
  calls: number;
  /** Calls that threw (network, API error). */
  failedCalls: number;
  /** Replies cut off at `max_tokens`. */
  cutOffCalls: number;
  /** Replies the model declined. */
  declinedCalls: number;
  /** Replies with no usable name in them. */
  unusableCalls: number;
  skipped: "no_model" | "disabled" | null;
}

export const emptyNameResult = (): NameJobResult => ({
  candidates: 0,
  named: 0,
  keyedClusters: 0,
  calls: 0,
  failedCalls: 0,
  cutOffCalls: 0,
  declinedCalls: 0,
  unusableCalls: 0,
  skipped: null,
});

/** The model names are written by: the engine's own, else the one the topics namer uses. */
export function nameModel(env: Record<string, string | undefined> = process.env): string {
  return (
    env.INTENT_ENGINE_NAME_MODEL ||
    env.TOPICS_LABEL_MODEL ||
    env.TRACE_WORKFLOW_LABEL_MODEL ||
    DEFAULT_LABEL_MODEL
  );
}

/** Clusters one run names at most: `INTENT_ENGINE_MAX_NAMES`, 0 turns naming off. */
export function maxNamesPerRun(env: Record<string, string | undefined> = process.env): number {
  return Math.floor(envNumber("INTENT_ENGINE_MAX_NAMES", DEFAULT_MAX_NAMES, (n) => n >= 0, env));
}

/** A structured-output Anthropic completion, or null without an API key. */
export function anthropicNamesComplete(
  model: string,
  env: Record<string, string | undefined> = process.env,
): NamesComplete | null {
  const apiKey = configured(env.ANTHROPIC_API_KEY);
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, timeout: NAME_TIMEOUT_MS, maxRetries: NAME_MAX_RETRIES });
  return async (system, user, keyed) => {
    const message = await client.messages.create({
      model,
      max_tokens: NAME_MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: keyed ? NAMES_KEYS_SCHEMA : NAMES_SCHEMA },
      },
    });
    if (message.stop_reason === "refusal") throw new NamesDeclinedError();
    if (message.stop_reason === "max_tokens") throw new NamesCutOffError();
    return message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  };
}

/** Read per run, so an env change or a dropped key (`make pipeline MODELS=off`) applies to the next run. */
export function defaultNameDeps(
  env: Record<string, string | undefined> = process.env,
): NameJobDeps {
  const model = nameModel(env);
  return { model, complete: anthropicNamesComplete(model, env), maxNames: maxNamesPerRun(env) };
}

/* the cache, applied during maintenance */

export type NameCache = ReadonlyMap<string, { label: string; hash: string; key: ActionKey | null }>;

/** Every model name the project holds, levels 0 and 1: a row per named cluster, never members. */
export async function loadNameCache(projectId: string, db: EngineDb): Promise<NameCache> {
  const rows = await db
    .select({
      id: intentClusters.id,
      label: intentClusters.llmLabel,
      hash: intentClusters.llmLabelHash,
      action: intentClusters.llmAction,
      object: intentClusters.llmObject,
    })
    .from(intentClusters)
    .where(
      and(
        eq(intentClusters.projectId, projectId),
        inArray(intentClusters.level, [0, 1]),
        sql`${intentClusters.llmLabel} is not null`,
      ),
    );
  return new Map(
    rows
      .filter((r) => r.label && r.hash)
      .map((r) => [
        r.id,
        {
          label: r.label!,
          hash: r.hash!,
          key: r.action && r.object ? { action: r.action, object: r.object } : null,
        },
      ]),
  );
}

/**
 * The cache entry while the cluster's central phrases are the ones it was
 * named from, else null. A name from either prompt stands; a key only from
 * the keyed prompt.
 */
const fresh = (cache: NameCache, id: string, level: NamedLevel, phrases: readonly string[]) => {
  const hit = cache.get(id);
  if (!hit || phrases.length === 0) return null;
  if (hit.hash === nameHash(level, phrases, true)) return hit;
  if (hit.hash === nameHash(level, phrases, false)) return { ...hit, key: null };
  return null;
};

/** Level 0: a cluster's model name while it is fresh, else null. */
export function cachedClusterName(
  cache: NameCache,
  cluster: Pick<EngineCluster, "uuid" | "members">,
): string | null {
  return fresh(cache, cluster.uuid, 0, namePhrases(cluster.members))?.label ?? null;
}

/** Level 0: the model's action and object for a cluster while fresh (model keys on), else null. */
export function cachedClusterKey(
  cache: NameCache,
  cluster: Pick<EngineCluster, "uuid" | "members">,
): ActionKey | null {
  return fresh(cache, cluster.uuid, 0, namePhrases(cluster.members))?.key ?? null;
}

/**
 * Level 1: the model's name. One whose phrases moved since it was written
 * stands until its new name is in, rather than falling back to the
 * rule-based one between two runs.
 */
export function applyCachedIntentNames(tree: LevelTree, cache: NameCache): void {
  for (const node of tree.levels[1] ?? []) {
    const name = cache.get(node.uuid)?.label;
    if (name) node.label = name;
  }
}

function intentPhrases(
  children: readonly string[],
  members: ReadonlyMap<string, readonly string[]>,
): string[] {
  return namePhrases(children.flatMap((id) => members.get(id) ?? []));
}

/* candidates */

export interface NameCandidate {
  id: string;
  level: NamedLevel;
  phrases: string[];
  hash: string;
  /** Asks behind it: busier first. */
  weight: number;
  /** Whether it already has a model name (a rename waits behind every first name). */
  named: boolean;
}

/**
 * The clusters this run's names would change, from the run's own clusters and
 * hierarchy: never named, or named from phrases they no longer stand for.
 * First names before renames, intents before query clusters, busiest first.
 */
export function nameCandidates(
  tree: LevelTree,
  clusters: readonly EngineCluster[],
  cache: NameCache,
  options: { levels: readonly NamedLevel[]; keyed: boolean },
): NameCandidate[] {
  const members = new Map(clusters.map((c) => [c.uuid, c.members]));
  const asks = new Map(clusters.map((c) => [c.uuid, c.asks]));
  const out: NameCandidate[] = [];
  const consider = (id: string, level: NamedLevel, phrases: string[], weight: number) => {
    if (phrases.length === 0) return;
    const hash = nameHash(level, phrases, options.keyed);
    const hit = cache.get(id);
    // Keys off: a name written with keys on is as good, and the key it carries is simply not read.
    if (
      hit &&
      (hit.hash === hash || (!options.keyed && hit.hash === nameHash(level, phrases, true)))
    )
      return;
    out.push({ id, level, phrases, hash, weight, named: hit !== undefined });
  };
  if (options.levels.includes(1)) {
    for (const node of tree.levels[1] ?? []) {
      consider(
        node.uuid,
        1,
        intentPhrases(node.children, members),
        node.children.reduce((sum, id) => sum + (asks.get(id) ?? 0), 0),
      );
    }
  }
  if (options.levels.includes(0)) {
    for (const c of clusters) consider(c.uuid, 0, namePhrases(c.members), c.asks);
  }
  return out.sort(
    (a, b) =>
      Number(a.named) - Number(b.named) ||
      b.level - a.level ||
      b.weight - a.weight ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/* the naming step */

/**
 * Name the first `deps.maxNames` candidates, {@link NAME_BATCH} per call, and
 * write each batch's names in a short transaction under the engine's lock. A
 * batch cut off at the token limit is tried once more as two halves.
 */
export async function nameEngineClusters(
  projectId: string,
  db: Pick<EngineDb, "transaction">,
  deps: NameJobDeps,
  candidates: readonly NameCandidate[],
): Promise<NameJobResult> {
  const result = emptyNameResult();
  if (!deps.complete) return { ...result, skipped: "no_model" };
  if (deps.maxNames <= 0) return { ...result, skipped: "disabled" };
  const complete = deps.complete;
  const keys = deps.keys ?? null;
  const keyed = keys !== null;
  result.candidates = candidates.length;
  const chosen = candidates.slice(0, deps.maxNames);
  const queue: Array<{ batch: NameCandidate[]; halvable: boolean }> = [];
  for (let i = 0; i < chosen.length; i += NAME_BATCH)
    queue.push({ batch: chosen.slice(i, i + NAME_BATCH), halvable: true });

  while (queue.length > 0) {
    const { batch, halvable } = queue.shift()!;
    const inputs: NameInput[] = batch.map((c, k) => ({
      key: `c${k + 1}`,
      level: c.level,
      phrases: c.phrases,
    }));
    const fields = { project_id: projectId, model: deps.model, batch: batch.length };
    result.calls += 1;
    let names: Map<string, ParsedName>;
    try {
      const { system, user } = buildNamesPrompt(inputs, keys?.vocabulary);
      names = parseNames(await complete(system, user, keyed), new Set(inputs.map((x) => x.key)));
    } catch (err) {
      if (err instanceof NamesCutOffError) {
        result.cutOffCalls += 1;
        const retry = halvable && batch.length > 1;
        logger.error(
          { err, ...fields, retried_in_halves: retry },
          "cluster names cut off at the token limit",
        );
        reportServerException(err, `project:${projectId}`, {
          operation: "intent_engine_names",
          stop_reason: "max_tokens",
          batch: batch.length,
        });
        if (retry) {
          const half = Math.ceil(batch.length / 2);
          queue.unshift(
            { batch: batch.slice(0, half), halvable: false },
            { batch: batch.slice(half), halvable: false },
          );
        }
      } else if (err instanceof NamesDeclinedError) {
        result.declinedCalls += 1;
        logger.error({ err, ...fields }, "cluster names declined by the model");
        reportServerException(err, `project:${projectId}`, {
          operation: "intent_engine_names",
          stop_reason: "refusal",
          batch: batch.length,
        });
      } else {
        result.failedCalls += 1;
        logger.error({ err, ...fields }, "cluster naming failed");
        reportServerException(err, `project:${projectId}`, {
          operation: "intent_engine_names",
          batch: batch.length,
        });
      }
      continue;
    }
    const named = batch.flatMap((c, k) => {
      const answer = names.get(`c${k + 1}`);
      if (!answer) return [];
      // A query cluster's key; an unusable one leaves the cluster to the rule-based key.
      const key = keys && c.level === 0 ? keys.parse(answer) : null;
      return [{ ...c, name: answer.name, key }];
    });
    if (named.length === 0) {
      result.unusableCalls += 1;
      logger.warn(fields, "cluster names came back unusable");
      continue;
    }
    await db.transaction(async (raw) => {
      const tx = raw as unknown as EngineDb;
      // Paid for: wait for the lock (bounded) rather than drop the names.
      await boundEngineTransaction(tx);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`intent-engine:${projectId}`}::text))`,
      );
      for (const n of named) {
        await tx
          .update(intentClusters)
          .set({
            llmLabel: n.name,
            llmLabelHash: n.hash,
            llmAction: n.key?.action ?? null,
            llmObject: n.key?.object ?? null,
            label: n.name,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(intentClusters.projectId, projectId),
              eq(intentClusters.id, n.id),
              eq(intentClusters.level, n.level),
            ),
          );
      }
    });
    result.named += named.length;
    result.keyedClusters += named.filter((n) => n.key).length;
  }
  return result;
}
