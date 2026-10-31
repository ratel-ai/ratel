import type {
  HealthPageModel,
  SignalView,
  WorkflowRowView,
  WorkflowsView,
} from "@/lib/readings/trace-signals/view";
import type { WorkflowLabels } from "@/lib/readings/trace-signals/workflows/name";

/**
 * The redacted copy of the Agent health model a public share link and every
 * PDF render.
 *
 * Built field by field from allowlists, never by spreading: each `Rules`
 * object names every key of its type, so a field added to `HealthPageModel`,
 * `SignalView`, `WorkflowsView` or `WorkflowRowView` fails typechecking here
 * until someone decides whether the public may see it.
 *
 * What stays: the readings, run shapes, workflows (their model-written names
 * and icons, steps, rates), the tool map and every problem with its claim,
 * cost and fix. Tool names stay: they are the subject of every claim. The
 * loader (`publicLoadOverrides`) already skips workflow descriptions and ask
 * insights; the rules below blank them again in case a caller did not.
 *
 * What goes: anything copied from a real run or written from users' words.
 * Example runs behind each problem (their searches can hold user text),
 * workflow example runs, the requests no tool handles, workflow descriptions,
 * the setup facts and capture nudges (how the project is wired), and every
 * turn and trace id.
 */
export function publicHealthModel(model: HealthPageModel): HealthPageModel {
  return pick(model, MODEL_RULES);
}

/** Model-written workflow labels with only their name and icon: descriptions never go public. */
export function publicWorkflowLabels(labels: WorkflowLabels): WorkflowLabels {
  return new Map([...labels].map(([id, label]) => [id, { name: label.name, icon: label.icon }]));
}

type Rules<T> = { [K in keyof T]-?: (value: T) => T[K] };

function pick<T extends object>(value: T, rules: Rules<T>): T {
  const out = {} as Record<keyof T, unknown>;
  for (const key of Object.keys(rules) as (keyof T)[]) {
    const kept = rules[key](value);
    if (kept !== undefined) out[key] = kept;
  }
  return out as T;
}

const same =
  <T, K extends keyof T>(key: K) =>
  (value: T): T[K] =>
    value[key];

const MODEL_RULES: Rules<HealthPageModel> = {
  windowDays: same("windowDays"),
  turns: same("turns"),
  waitingOn: same("waitingOn"),
  floor: same("floor"),
  captureLevel: same("captureLevel"),
  turnSourceMix: same("turnSourceMix"),
  sourceMode: same("sourceMode"),
  tiles: same("tiles"),
  flow: same("flow"),
  shapes: same("shapes"),
  signals: (m) => m.signals.map(publicSignal),
  tooEarly: (m) => m.tooEarly.map(publicSignal),
  lockedCount: same("lockedCount"),
  // What the team hid is the team's own housekeeping: never on a public page.
  dismissed: () => undefined,
  // No example runs on a shared page, so no drawer and no upsell for one.
  evidenceTurnsPerSignal: () => 0,
  captureUnlocks: () => [],
  setup: () => null,
  computedAt: same("computedAt"),
  signalWindowDays: same("signalWindowDays"),
  workflows: (m) => (m.workflows ? pick(m.workflows, WORKFLOWS_RULES) : null),
  // How the team's ingest was keeping up when the reading ran: the member page's business.
  unbuiltAtReading: () => undefined,
};

const SIGNAL_RULES: Rules<SignalView> = {
  id: same("id"),
  kind: same("kind"),
  tier: same("tier"),
  status: same("status"),
  subject: same("subject"),
  claim: same("claim"),
  claimSegments: same("claimSegments"),
  figure: same("figure"),
  severity: same("severity"),
  impact: same("impact"),
  cost: same("cost"),
  n: same("n"),
  interval: same("interval"),
  fix: same("fix"),
  fixRoute: same("fixRoute"),
  caveat: same("caveat"),
  turnSourceMix: same("turnSourceMix"),
  evidence: (s) => ({ chart: s.evidence.chart, turns: [], totalTurns: s.evidence.totalTurns }),
  firstSeenAt: same("firstSeenAt"),
  lastSeenAt: same("lastSeenAt"),
};

function publicSignal(signal: SignalView): SignalView {
  return pick(signal, SIGNAL_RULES);
}

const WORKFLOWS_RULES: Rules<WorkflowsView> = {
  items: (w) => w.items.map((row) => pick(row, WORKFLOW_ROW_RULES)),
  multiToolTurns: same("multiToolTurns"),
  assignedTurns: same("assignedTurns"),
  minTools: same("minTools"),
  minRuns: same("minRuns"),
  chainOwners: same("chainOwners"),
  unserved: () => [],
  blocked: same("blocked"),
  readingSince: same("readingSince"),
  excludedRuns: same("excludedRuns"),
  // Where the requests came from says nothing once none are shown.
  asksFrom: () => null,
};

const WORKFLOW_ROW_RULES: Rules<WorkflowRowView> = {
  id: same("id"),
  name: same("name"),
  description: () => null,
  icon: same("icon"),
  steps: same("steps"),
  focusTools: same("focusTools"),
  runs: same("runs"),
  share: same("share"),
  completion: same("completion"),
  medianMs: same("medianMs"),
  problem: same("problem"),
  build: same("build"),
  failingStep: same("failingStep"),
  slowestStep: same("slowestStep"),
  examples: () => [],
  // Read from users' asks, like the requests no tool handles.
  stoppedShort: () => null,
  model: same("model"),
};
