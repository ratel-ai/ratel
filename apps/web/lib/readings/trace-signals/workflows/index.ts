/** Workflow mining (Phase W1): pure functions from closed turns to workflows, their health and their signals. */

export type {
  Assignment,
  AssignOptions,
  CoreMatch,
} from "@/lib/readings/trace-signals/workflows/assign";
export {
  assignTurn,
  jaccard,
  MATCH_PREVIOUS_JACCARD,
  matchPrevious,
  matchScore,
} from "@/lib/readings/trace-signals/workflows/assign";
export type {
  WorkflowThresholds,
  WorkflowWithHealth,
} from "@/lib/readings/trace-signals/workflows/detect";
export {
  detectWorkflowSignals,
  WORKFLOW_THRESHOLDS,
} from "@/lib/readings/trace-signals/workflows/detect";
export {
  WORKFLOW_EVIDENCE_TURNS,
  workflowHealth,
} from "@/lib/readings/trace-signals/workflows/health";
export { mineWorkflows } from "@/lib/readings/trace-signals/workflows/mine";
export type { ToolNames } from "@/lib/readings/trace-signals/workflows/name";
export {
  WORKFLOW_NAME_SEPARATOR,
  workflowDisplayName,
} from "@/lib/readings/trace-signals/workflows/name";
export {
  orderStability,
  typicalOrder,
  workflowFingerprint,
} from "@/lib/readings/trace-signals/workflows/order";
export type {
  TurnUnit,
  Workflow,
  WorkflowConfig,
  WorkflowCore,
  WorkflowExample,
  WorkflowHealth,
  WorkflowMiningResult,
  WorkflowSignal,
  WorkflowSignalKind,
  WorkflowSlowStep,
  WorkflowStep,
  WorkflowStepShare,
  WorkflowToolCall,
  WorkflowTurn,
} from "@/lib/readings/trace-signals/workflows/types";
export { DEFAULT_WORKFLOW_CONFIG } from "@/lib/readings/trace-signals/workflows/types";
export {
  firstCallPath,
  isToolCall,
  toolCalls,
  turnUnit,
} from "@/lib/readings/trace-signals/workflows/units";
