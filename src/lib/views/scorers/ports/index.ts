import type {
  DecisionOptionConfig,
  Scorer,
  ScorerDefinition,
  ScorerOverride,
  ScorerScope,
} from "../domain/types";

/**
 * What the scorer domain needs from outside. Model ports return null when no
 * model is configured or the budget refuses the call: the scorer then skips.
 */

export interface JudgePort {
  judge(input: {
    criteria: string;
    transcript: string;
  }): Promise<{ value: number; detail?: string } | null>;
}

export interface DecisionPort {
  decide(input: {
    question: string;
    options: readonly DecisionOptionConfig[];
    transcript: string;
  }): Promise<{ choice: string; probabilities?: Record<string, number> } | null>;
}

export interface ScorerPorts {
  judge?: JudgePort | null;
  decision?: DecisionPort | null;
}

export type NewScorer = ScorerDefinition & {
  projectId: string;
  name: string;
  scope: ScorerScope;
  taskId: string | null;
  enabled?: boolean;
  goodThreshold?: number;
  createdBy: string;
};

export interface ScorerPatch {
  name?: string;
  kind?: ScorerDefinition["kind"];
  config?: unknown;
  enabled?: boolean;
  goodThreshold?: number;
  updatedBy: string;
}

/** Saved scorers and per-eval overrides. Every method is project-scoped. */
export interface ScorerRepository {
  list(projectId: string, filter?: { taskId?: string; scope?: ScorerScope }): Promise<Scorer[]>;
  get(projectId: string, id: string): Promise<Scorer | null>;
  create(input: NewScorer): Promise<Scorer>;
  update(projectId: string, id: string, patch: ScorerPatch): Promise<Scorer | null>;
  remove(projectId: string, id: string): Promise<boolean>;
  /** Null clears the override so the scorer's own switch applies again. */
  setOverride(
    projectId: string,
    evalId: string,
    scorerId: string,
    enabled: boolean | null,
    updatedBy: string,
  ): Promise<void>;
  overrides(projectId: string, evalIds: readonly string[]): Promise<Map<string, ScorerOverride[]>>;
}
