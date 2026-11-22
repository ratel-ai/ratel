/**
 * ⚠️ **Experimental.** The prompt and model catalog: one way for agent code to
 * read its prompts and models, so that a Ratel sandbox can change them per run.
 *
 * Import it from its own entrypoint, `@ratel-ai/sdk/experimental/catalog`. It may
 * change or be removed without a major-version bump.
 *
 * ```ts
 * import { ratel } from "@ratel-ai/sdk/experimental/catalog";
 * const system = ratel.prompt("system", "You answer from the docs.");
 * const modelId = ratel.model("answer", "anthropic/claude-haiku-5-5");
 * ```
 *
 * Resolution, first match wins (v1 simulates the hosted catalog, no network call):
 * 1. the override of the active sandbox run (set by `@ratel-ai/sandbox` through
 *    the {@link CATALOG_HOST_KEY} slot on `globalThis`);
 * 2. the local catalog file `ratel.catalog.json` (`RATEL_CATALOG_FILE`, else the
 *    working directory): `{ "prompts": { id: string }, "models": { id: string } }`;
 * 3. the default the code passes.
 *
 * Each read is recorded (kind, id, default), so a sandbox can turn the prompts and
 * models that code reads into params.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recordRead } from "./sdk-registry.js";

/** What a catalog entry holds: a prompt template or a `provider/model` id. */
export type CatalogKind = "prompt" | "model";

/** One prompt or model that code read, with the default it passed. */
export interface CatalogRead {
  /** Prompt or model. */
  readonly kind: CatalogKind;
  /** The catalog id the code passed. */
  readonly id: string;
  /** The default the code passed. */
  readonly default: string;
  /** The value of the local catalog file for this id, when it has one: the baseline over `default`. */
  readonly catalog?: string;
}

/**
 * What a sandbox runner installs on `globalThis[CATALOG_HOST_KEY]` for a run. A
 * global slot, not an import, so that two copies of this package (or none in the
 * runner) still agree.
 */
export interface CatalogHost {
  /** The override for this run, or undefined to fall through to the catalog file. */
  resolve(kind: CatalogKind, id: string): string | undefined;
  /** Called on each read. */
  record(read: CatalogRead): void;
  /** The toolset this run uses in place of `tools`: tool modes applied, edits and disabled tools served. */
  toolset?<T>(tools: T): T;
  /** The skills this run offers in place of `skills`: disabled ones left out, edits and modes applied. */
  skills?(skills: readonly SkillView[]): readonly SkillView[];
  /**
   * The run's view of one registered skill, read by the standard `SkillCatalog`
   * boundaries (search, has, get, invoke, get_skill_content): `undefined` when the run
   * does not bind it (the catalog as registered), `null` when the run disables it.
   */
  skill?(skillId: string): RunSkill | null | undefined;
}

/** A skill as one sandbox run sees it. */
export interface RunSkill {
  /** The run's description, when it edits it. */
  readonly description?: string;
  /** How a load runs: `real` returns the body, `fake` and `confirm` go through the sandbox. */
  readonly mode: "real" | "fake" | "confirm";
  /** Loads the skill in its mode. `readBody` returns the stored body; a fake never calls it. Throws on a reviewer's reject. */
  load(readBody: () => string): Promise<string>;
}

/** Whether a sandbox run with a skill view is active. */
export function runSkillViewActive(): boolean {
  return typeof activeHost()?.skill === "function";
}

/** The active run's view of a skill: see {@link CatalogHost.skill}. */
export function activeRunSkill(skillId: string): RunSkill | null | undefined {
  return activeHost()?.skill?.(skillId);
}

/** A skill as the code offers it to the model: what {@link ratel}.skills returns. */
export interface SkillView {
  /** The skill id, as registered. */
  readonly id: string;
  /** What the model sees: the run's edited description inside a sandbox run. */
  readonly description: string;
  /** Loads the skill's instructions: in a sandbox run, through the skill's mode (real, fake, confirm). */
  load(): Promise<string>;
}

/** The fields of a registered skill that {@link ratel}.skills reads. */
export interface SkillSource {
  /** The skill id. */
  readonly id: string;
  /** What the skill covers. */
  readonly description: string;
  /** The instructions `load()` returns. */
  readonly body?: string;
}

/** The `globalThis` key of the active {@link CatalogHost}. */
export const CATALOG_HOST_KEY: unique symbol = Symbol.for("ratel.catalog.host.v1") as never;

/** The local catalog file looked up in the working directory when `RATEL_CATALOG_FILE` is unset. */
export const CATALOG_FILE_NAME = "ratel.catalog.json";

interface CatalogFile {
  readonly path: string;
  readonly prompts: Readonly<Record<string, string>>;
  readonly models: Readonly<Record<string, string>>;
}

const reads = new Map<string, CatalogRead>();
let cachedFile: CatalogFile | null | undefined;
let cachedPath: string | undefined;

/** Read prompts and models from the catalog. */
export const ratel = {
  /** The prompt template with this id: the run override, the catalog value, else `defaultTemplate`. */
  prompt(id: string, defaultTemplate: string): string {
    return resolve("prompt", id, defaultTemplate);
  },
  /** The `provider/model` id with this id: the run override, the catalog value, else `defaultModel`. */
  model(id: string, defaultModel: string): string {
    return resolve("model", id, defaultModel);
  },
  /**
   * The toolset to hand the model: inside a sandbox run, the run's version of
   * `tools` (per-run tool modes, edited descriptions, disabled tools); else
   * `tools` unchanged. Register the tools on a `ratel()` core so a sandbox lists them.
   */
  toolset<T extends object>(tools: T): T {
    return activeHost()?.toolset?.(tools) ?? tools;
  },
  /**
   * The skills to offer the model, for example one tool per skill: inside a sandbox
   * run, the run's view of them (a disabled skill left out, an edited description,
   * `load()` through the skill's mode); else every skill, with `load()` returning its
   * body. Register the skills on a `ratel()` core so a sandbox lists them.
   */
  skills(skills: readonly SkillSource[]): readonly SkillView[] {
    const view: SkillView[] = skills.map((skill) => ({
      id: skill.id,
      description: skill.description,
      load: async () => skill.body ?? "",
    }));
    return activeHost()?.skills?.(view) ?? view;
  },
} as const;

/** Every prompt and model read in this process so far, in first-read order. */
export function experimentalCatalogReads(): CatalogRead[] {
  return [...reads.values()];
}

/** Test-only: forget the reads and the cached catalog file. */
export function resetCatalogForTest(): void {
  reads.clear();
  cachedFile = undefined;
  cachedPath = undefined;
}

function resolve(kind: CatalogKind, id: string, fallback: string): string {
  if (typeof id !== "string" || id === "") {
    throw new TypeError(`ratel.${kind}(id, default): id must be a non-empty string`);
  }
  if (typeof fallback !== "string") {
    throw new TypeError(`ratel.${kind}("${id}", default): default must be a string`);
  }
  const file = catalogFile();
  const fromFile = kind === "prompt" ? file?.prompts[id] : file?.models[id];
  const read: CatalogRead = {
    kind,
    id,
    default: fallback,
    ...(fromFile !== undefined ? { catalog: fromFile } : {}),
  };
  const key = `${kind}:${id}`;
  if (!reads.has(key)) reads.set(key, read);
  recordRead(read);
  const host = activeHost();
  host?.record(read);
  return host?.resolve(kind, id) ?? fromFile ?? fallback;
}

function activeHost(): CatalogHost | undefined {
  return (globalThis as { [CATALOG_HOST_KEY]?: CatalogHost })[CATALOG_HOST_KEY];
}

function catalogFile(): CatalogFile | null {
  const path = process.env.RATEL_CATALOG_FILE || join(process.cwd(), CATALOG_FILE_NAME);
  if (cachedFile !== undefined && cachedPath === path) return cachedFile;
  cachedPath = path;
  cachedFile = existsSync(path) ? parseCatalogFile(path) : null;
  return cachedFile;
}

function parseCatalogFile(path: string): CatalogFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${(error as Error).message})`);
  }
  if (!isRecord(raw)) throw new Error(`${path}: must be a JSON object`);
  return {
    path,
    prompts: stringMap(path, raw, "prompts"),
    models: stringMap(path, raw, "models"),
  };
}

function stringMap(path: string, raw: Record<string, unknown>, section: string) {
  const value = raw[section];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${path}: ${section} must be an object of strings`);
  for (const [id, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`${path}: ${section}.${id} must be a string`);
  }
  return value as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
