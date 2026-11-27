import { isTrialCheckPath } from "@/lib/contracts/check";
import type { Scorer, ScorerDefinition } from "@/lib/views/scorers/types";
import { type EvalScorer, type EvalScorerRef, refIdOf } from "./eval";
import {
  PREDEFINED_SCORERS,
  type PredefinedKey,
  type PredefinedSetting,
  predefinedDefinition,
  trialCheckOfPreset,
} from "./predefined-scorers";

/**
 * The scorer library (decision `scorer-library`): the scorers that an eval can refer to. They are
 * the project's scorers (`views/scorers`, the one scorer model) and the pre-defined set. The scorers
 * that an eval had before the library stay in the eval as its own scorers: the library shows them
 * as "from this eval". A run freezes a snapshot of each scorer that it uses (`score.ts#snapshotOf`).
 */

export type LibrarySource = "project" | "predefined" | "eval";

export type LibraryScorer = {
  source: LibrarySource;
  /** The id of a reference to it: `project:<id>`, `predefined:<key>`, or the eval scorer id. */
  refId: string;
  name: string;
  kind: ScorerDefinition["kind"];
  description: string | null;
  /** What a pre-defined scorer needs: a text, a tool, a limit. Null: nothing. */
  setting: PredefinedSetting;
  /** False when an eval trial cannot run it, with the reason. */
  usable: boolean;
  reason: string | null;
  /** For a scorer from an eval: the eval. */
  evalId?: string;
  evalName?: string;
};

/** The definition that an eval trial runs for a project scorer, or why there is none. */
export function trialDefinitionOf(
  scorer: Pick<Scorer, "kind" | "config">,
): { ok: true; definition: EvalScorer["definition"] } | { ok: false; reason: string } {
  const definition = { kind: scorer.kind, config: scorer.config } as ScorerDefinition;
  switch (definition.kind) {
    case "check":
      return isTrialCheckPath(definition.config.path)
        ? { ok: true, definition: { kind: "check", config: definition.config } }
        : {
            ok: false,
            reason: `An eval trial has no ${definition.config.path}. A check of a trial reads the output, the tools, the time, the cost or the tokens.`,
          };
    case "judge":
      return definition.config.output === "boolean"
        ? { ok: true, definition: { kind: "judge", config: { ...definition.config, output: "boolean" } } }
        : { ok: false, reason: "A judge of an eval answers yes or no. This judge gives 1 to 5." };
    case "preset": {
      const check = trialCheckOfPreset(definition.config);
      return check
        ? { ok: true, definition: { kind: "check", config: check } }
        : {
            ok: false,
            reason: `The preset ${definition.config.preset} reads a task run. An eval trial does not have it.`,
          };
    }
  }
}

/** The library of a project: its scorers, the pre-defined set, and the scorers of its evals. */
export function libraryOf(
  projectScorers: readonly Scorer[],
  evals: ReadonlyArray<{ id: string; name: string; scorers: readonly EvalScorerRef[] }>,
): LibraryScorer[] {
  const own = projectScorers.map((scorer): LibraryScorer => {
    const trial = trialDefinitionOf(scorer);
    return {
      source: "project",
      refId: `project:${scorer.id}`,
      name: scorer.name,
      kind: scorer.kind,
      description: null,
      setting: null,
      usable: trial.ok,
      reason: trial.ok ? null : trial.reason,
    };
  });
  const predefined = PREDEFINED_SCORERS.map(
    (scorer): LibraryScorer => ({
      source: "predefined",
      refId: `predefined:${scorer.key}`,
      name: scorer.name,
      kind: scorer.kind,
      description: scorer.description,
      setting: scorer.setting,
      usable: true,
      reason: null,
    }),
  );
  const fromEvals = evals.flatMap(({ id: evalId, name: evalName, scorers }) =>
    scorers.flatMap((ref): LibraryScorer[] =>
      ref.source === "project" || ref.source === "predefined"
        ? []
        : [
            {
              source: "eval",
              refId: ref.id,
              name: ref.name,
              kind: ref.definition.kind,
              description: null,
              setting: null,
              usable: true,
              reason: null,
              evalId,
              evalName,
            },
          ],
    ),
  );
  return [...own, ...predefined, ...fromEvals];
}

export type ResolvedScorers =
  | { ok: true; scorers: EvalScorer[] }
  | { ok: false; reason: "scorer_not_found" | "scorer_not_usable"; message: string };

/**
 * The scorers that a run uses, from the references: each with the id of its reference, its name,
 * its gating and the definition that it has now. The run freezes them.
 */
export function resolveScorers(
  refs: readonly EvalScorerRef[],
  projectScorers: readonly Scorer[],
): ResolvedScorers {
  const scorers: EvalScorer[] = [];
  for (const ref of refs) {
    const id = refIdOf(ref);
    if (ref.source === "project") {
      const found = projectScorers.find((scorer) => scorer.id === ref.scorerId);
      if (!found) {
        return {
          ok: false,
          reason: "scorer_not_found",
          message: `The project has no scorer ${ref.scorerId}. It was deleted, or it is of another project.`,
        };
      }
      const trial = trialDefinitionOf(found);
      if (!trial.ok) {
        return {
          ok: false,
          reason: "scorer_not_usable",
          message: `The scorer "${found.name}" cannot score an eval trial. ${trial.reason}`,
        };
      }
      scorers.push({ id, name: found.name, gating: ref.gating, definition: trial.definition });
      continue;
    }
    if (ref.source === "predefined") {
      const made = predefinedDefinition(ref.key as PredefinedKey, ref.value);
      if (!made.ok) return { ok: false, reason: "scorer_not_found", message: made.message };
      const name = PREDEFINED_SCORERS.find(({ key }) => key === ref.key)?.name ?? ref.key;
      const named = ref.value === undefined ? name : `${name}: ${ref.value}`;
      scorers.push({
        id,
        name: named,
        gating: ref.gating,
        definition: made.definition as EvalScorer["definition"],
      });
      continue;
    }
    const { source: _, ...own } = ref;
    scorers.push({ ...own, id });
  }
  return { ok: true, scorers };
}
