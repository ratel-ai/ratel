/**
 * The one seam between the MCP `run_eval` / `get_eval` tools and the eval gate (RC-46).
 *
 * `runSimulation(fixId, { projectId, trigger, actor, background })` queues a
 * replay of N of the project's historical runs with the fix applied, offline
 * and in-process, and returns a `SimulationOutcome` (pass rate and score
 * before → after, the verdict, the eval page; status queued or running when
 * it was queued). It also records the eval → fix lineage link.
 * `latestEvalOutcome` reads the fix's newest simulation back (RC-70).
 * Imported from the service module, not the eval gate's index, so MCP does
 * not pull in the page model.
 */
export {
  EvalGateError,
  latestEvalOutcome,
  type RunSimulationOptions,
  runSimulation,
} from "@/lib/views/eval-gate/service";
export type { SimulationOutcome, Tally as SimulationTally } from "@/lib/views/eval-gate/types";
