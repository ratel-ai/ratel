/**
 * The eval gate (RC-46), the stable entry point other surfaces import:
 * Fixes and the eval page, and RC-43's MCP `run_eval`.
 *
 *   const outcome = await runSimulation("craft:<uuid>", { projectId, trigger: "mcp" });
 *   outcome.label;   // "Simulated on 18 historical runs"
 *   outcome.before;  // { passed, total, passRate, score }
 *   outcome.after;
 *   outcome.verdict; // "better" | "same" | "worse" | "too-few" | "unsupported"
 *   outcome.source;  // LineageRef of the insight the fix came from
 *
 * A simulation replays the project's own historical runs with the fix applied,
 * in-process. It never calls a tool, a model or the customer's environment.
 */

export { SIMULATE_FIX_EVAL_JOB } from "./job-kind";
export { type EvalGatePageModel, loadEvalGatePage } from "./page-model";
export {
  type EvalGateDeps,
  EvalGateError,
  ensureEvalSet,
  executeEvalRun,
  listEvalBadges,
  type RunSimulationOptions,
  runSimulation,
} from "./service";
export {
  type CaseSimulation,
  type SimulationBudget,
  type SimulationCase,
  type SimulationChange,
  simulateCases,
} from "./simulation";
export type { EvalBadge, Expected, FixChange, SimulationOutcome, Tally, Verdict } from "./types";
export { badgeSentence, evalHref, simulatedLabel } from "./view";
