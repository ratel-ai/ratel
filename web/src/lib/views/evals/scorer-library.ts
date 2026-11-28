import { isTrialCheckPath } from "@/lib/contracts/check";
import type { Scorer } from "@/lib/views/scorers/types";
import { currentVersion, type EvalScorer, evalScorerSchema, type ScorerRef } from "./domain/eval";
import { buildPredefined, PREDEFINED_SCORERS } from "./domain/predefined-scorers";
import type { EvalStore } from "./ports/eval-store";
import type { ScorerLibrary } from "./ports/scorer-library";

/**
 * The scorer library (decision `scorer-library`): the project's scorers, the pre-defined set, and
 * each scorer that an eval holds itself ("from this eval": the scorers of the evals from before the
 * library stay in their eval, so no scorer starts to score the project's traces). An eval refers to
 * a library scorer, and a run resolves the reference again and freezes what it found.
 */

type Definition = EvalScorer["definition"];

export type LibraryEntry = {
  source: "project" | "predefined" | "eval";
  /** The scorer id, the pre-defined key, or `<eval id>:<scorer id>`. */
  id: string;
  name: string;
  description: string | null;
  kind: Scorer["kind"];
  /** Whether an eval trial can run it. */
  usable: boolean;
  /** Why it is not usable. */
  why: string | null;
  /** The settings that a pre-defined scorer needs. */
  settings: ReadonlyArray<{ name: string; type: "string" | "number"; description: string }>;
  /** The eval that holds a scorer from an eval. */
  evalName: string | null;
};

export type ResolvedScorers = { ok: true; scorers: EvalScorer[] } | { ok: false; message: string };

export async function listScorerLibrary(
  projectId: string,
  deps: { library: ScorerLibrary; evals: Pick<EvalStore, "list"> },
): Promise<LibraryEntry[]> {
  const [scorers, evals] = await Promise.all([
    deps.library.projectScorers(projectId),
    deps.evals.list(projectId),
  ]);
  const project = scorers.map((scorer): LibraryEntry => {
    const found = evalDefinitionOf(scorer);
    return {
      source: "project",
      id: scorer.id,
      name: scorer.name,
      description: null,
      kind: scorer.kind,
      usable: found.ok,
      why: found.ok ? null : found.why,
      settings: [],
      evalName: null,
    };
  });
  const predefined = PREDEFINED_SCORERS.map(
    (scorer): LibraryEntry => ({
      source: "predefined",
      id: scorer.key,
      name: scorer.name,
      description: scorer.description,
      kind: scorer.kind,
      usable: true,
      why: null,
      settings: scorer.settings,
      evalName: null,
    }),
  );
  const fromEvals = evals.flatMap((definition) =>
    currentVersion(definition)
      .scorers.filter(({ ref }) => ref === undefined)
      .map(
        (scorer): LibraryEntry => ({
          source: "eval",
          id: `${definition.id}:${scorer.id}`,
          name: scorer.name,
          description: null,
          kind: scorer.definition.kind,
          usable: true,
          why: null,
          settings: [],
          evalName: definition.name,
        }),
      ),
  );
  return [...project, ...predefined, ...fromEvals];
}

/**
 * The scorers as a run uses them: each reference resolved again (a project scorer as it is now, a
 * pre-defined one with its settings), and each scorer from the eval as it is. A reference that is
 * gone or that a trial cannot run refuses the run.
 */
export async function resolveScorers(
  projectId: string,
  scorers: readonly EvalScorer[],
  library: ScorerLibrary,
): Promise<ResolvedScorers> {
  const needsProject = scorers.some(({ ref }) => ref?.source === "project");
  const project = needsProject ? await library.projectScorers(projectId) : [];
  const resolved: EvalScorer[] = [];
  for (const scorer of scorers) {
    if (!scorer.ref) {
      resolved.push(scorer);
      continue;
    }
    const found = definitionOfRef(scorer.ref, project);
    if (!found.ok) return { ok: false, message: `The scorer "${scorer.name}": ${found.why}` };
    resolved.push({ ...scorer, definition: found.definition });
  }
  return { ok: true, scorers: resolved };
}

/** A scorer of the eval from a reference, with the definition that the library gives now. */
export async function scorerFromRef(
  projectId: string,
  scorer: { id: string; name: string; gating: boolean; ref: ScorerRef },
  library: ScorerLibrary,
): Promise<{ ok: true; scorer: EvalScorer } | { ok: false; message: string }> {
  const project = scorer.ref.source === "project" ? await library.projectScorers(projectId) : [];
  const found = definitionOfRef(scorer.ref, project);
  if (!found.ok) return { ok: false, message: `The scorer "${scorer.name}": ${found.why}` };
  return { ok: true, scorer: { ...scorer, definition: found.definition } };
}

function definitionOfRef(
  ref: ScorerRef,
  project: readonly Scorer[],
): { ok: true; definition: Definition } | { ok: false; why: string } {
  if (ref.source === "predefined") {
    const built = buildPredefined(ref.key, ref.settings);
    return built.ok ? built : { ok: false, why: built.message };
  }
  const scorer = project.find(({ id }) => id === ref.scorerId);
  if (!scorer) return { ok: false, why: "it is not in the library of the project any more." };
  return evalDefinitionOf(scorer);
}

/** The definition of a project scorer that an eval trial can run, or why there is none. */
function evalDefinitionOf(
  scorer: Scorer,
): { ok: true; definition: Definition } | { ok: false; why: string } {
  if (scorer.kind === "preset") {
    return {
      ok: false,
      why: "a task preset reads the runs of a task, not one trial. Use the pre-defined scorer with the same measure.",
    };
  }
  if (scorer.kind === "judge" && scorer.config.output !== "boolean") {
    return { ok: false, why: "an eval judge answers yes or no, and this judge gives a number." };
  }
  if (scorer.kind === "check" && !isTrialCheckPath(scorer.config.path)) {
    return {
      ok: false,
      why: `a trial has no ${scorer.config.path}: it reads the output, the tools, the usage and the tool arguments.`,
    };
  }
  const definition = { kind: scorer.kind, config: scorer.config };
  const parsed = evalScorerSchema.shape.definition.safeParse(definition);
  return parsed.success
    ? { ok: true, definition: parsed.data }
    : { ok: false, why: "an eval trial cannot run its settings." };
}
