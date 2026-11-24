import type { StepDraft } from "@/lib/ledger/types";
import { nodeIdOf } from "@/lib/readings/tool-explorer/units";
import {
  actionClassOf,
  isProbe,
  toolName,
} from "@/lib/readings/trace-signals/hallucinations/action-class";
import { claimsCompletion } from "@/lib/readings/trace-signals/hallucinations/claims";
import { errorShapeOf } from "@/lib/readings/trace-signals/hallucinations/error-shapes";
import type {
  HallucinationEvidence,
  HallucinationKind,
} from "@/lib/readings/trace-signals/hallucinations/kinds";
import { type FailureStreak, failureStreaks } from "@/lib/readings/trace-signals/outcomes/followed";

/**
 * The hallucinations of one turn, by rule. Pure.
 *
 * One finding per thing made up, at the step it starts on:
 *   - a run of calls that asked for one tool and ran another (the runtime
 *     rerouted a name that is not a tool's): `tool_rerouted`, or
 *     `tool_action_changed` when the tool that ran does something else;
 *   - a failure streak (`failureStreaks`: consecutive failed calls of one
 *     tool) with a try whose error names a tool that does not exist, a record
 *     that does not, or the values it takes instead: one finding, on the
 *     first such try. A streak a reroute already covers is that reroute, not
 *     a second finding;
 *   - a call that worked whose result said no such tool exists;
 *   - a reply that claims the work is done after an acting call (one that
 *     creates, changes or removes) failed and no later call of the same kind
 *     worked.
 *
 * Two guards need the whole window, so the caller applies them after its
 * walk (`run.ts`): a requested name that did run under its own name is an
 * alias, not a made-up tool; a tool that worked elsewhere exists.
 */

export interface Finding {
  kind: HallucinationKind;
  /** 1-based ordinal, in the turn, of the step the finding starts on. */
  stepOrdinal: number;
  /** The tool that ran, as a node id (a skill as `skill:<id>`). */
  toolId: string;
  /** The tool the agent asked for, when it differs. */
  requestedToolId: string | null;
  evidence: HallucinationEvidence;
  /** Calls the finding covers: the tries of one streak. */
  repeats: number;
  /** The last of those calls worked: a rerouted name that still got an answer. */
  worked: boolean;
  occurredAt: Date;
}

export interface DetectInput {
  /** The turn's steps in ordinal order. */
  steps: readonly StepDraft[];
  /** Error text by event id (a step's end event, else its start), where one is still kept. */
  errors: ReadonlyMap<string, string>;
  /** The tool id the agent asked for, by event id, where the SDK sent one that differs from the tool that ran. */
  requested: ReadonlyMap<string, string>;
  /** Event ids of calls whose result said no such tool exists. */
  noSuchTool: ReadonlySet<string>;
  /** Names and ids the catalog holds (`catalogIdentities`); null when the project has no catalog to check against. */
  catalog: ReadonlySet<string> | null;
  /** The agent's final reply in the turn; null when none was captured. */
  reply: string | null;
}

/** An id as a tool would have one: the agent's own string is kept only when it is one. */
const ID_SHAPED = /^[\w.:/-]{1,120}$/;

const eventIdsOf = (step: StepDraft): string[] =>
  step.endTraceEventId ? [step.traceEventId, step.endTraceEventId] : [step.traceEventId];

export function requestedOf(
  step: StepDraft,
  requested: ReadonlyMap<string, string>,
): string | null {
  for (const id of eventIdsOf(step)) {
    const asked = requested.get(id)?.trim();
    if (asked) return asked;
  }
  return null;
}

const errorOf = (step: StepDraft, errors: ReadonlyMap<string, string>): string | null =>
  errors.get(step.endTraceEventId ?? step.traceEventId) ?? null;

/** Each catalog's names as they are compared (`toolName`: no namespace, lower case), built once per catalog. */
const comparedNames = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();
function namesOf(catalog: ReadonlySet<string>): ReadonlySet<string> {
  let names = comparedNames.get(catalog);
  if (!names) {
    names = new Set([...catalog].map(toolName));
    comparedNames.set(catalog, names);
  }
  return names;
}

const inCatalog = (id: string, catalog: ReadonlySet<string> | null): boolean =>
  catalog !== null && (catalog.has(id) || namesOf(catalog).has(toolName(id)));

/**
 * The turn's first failure streak of an acting tool (one that creates,
 * changes or removes) that no later call of the same kind made up for; null
 * when there is none. A reply that says "done" over it is a false report.
 */
export function unrecoveredActingFailure(steps: readonly StepDraft[]): FailureStreak | null {
  const calls = steps.flatMap((step) => {
    const node = nodeIdOf(step);
    return node === null ? [] : [{ step, node }];
  });
  for (const streak of failureStreaks(steps)) {
    const kind = actionClassOf(streak.tool);
    if (kind === null || kind === "read") continue;
    const last = streak.ordinals.at(-1)!;
    if (
      !calls.some(
        ({ step, node }) =>
          step.ordinal > last && step.outcome === "ok" && actionClassOf(node) === kind,
      )
    )
      return streak;
  }
  return null;
}

export function detectHallucinations(input: DetectInput): Finding[] {
  const { steps, errors, catalog } = input;
  const calls = steps.flatMap((step) => {
    const node = nodeIdOf(step);
    return node === null ? [] : [{ step, node }];
  });
  const findings: Finding[] = [];
  /** Ordinals a reroute finding already covers. */
  const rerouted = new Set<number>();

  // Reroutes: consecutive calls that asked for the same name and ran the same tool are one finding.
  for (let i = 0; i < calls.length; i++) {
    const { step, node } = calls[i]!;
    const asked = requestedOf(step, input.requested);
    if (
      asked === null ||
      !ID_SHAPED.test(asked) ||
      toolName(asked) === toolName(node) ||
      inCatalog(asked, catalog)
    )
      continue;
    let repeats = 1;
    let last = step;
    rerouted.add(step.ordinal);
    while (
      i + 1 < calls.length &&
      calls[i + 1]!.node === node &&
      requestedOf(calls[i + 1]!.step, input.requested) === asked
    ) {
      i += 1;
      repeats += 1;
      last = calls[i]!.step;
      rerouted.add(last.ordinal);
    }
    const from = actionClassOf(asked);
    const to = actionClassOf(node);
    findings.push({
      kind: from !== null && to !== null && from !== to ? "tool_action_changed" : "tool_rerouted",
      stepOrdinal: step.ordinal,
      toolId: node,
      requestedToolId: asked,
      evidence: "requested_differs",
      repeats,
      worked: last.outcome === "ok",
      occurredAt: step.occurredAt,
    });
  }

  // Failure streaks: what the error says was made up.
  const streaks = failureStreaks(steps);
  const stepAt = new Map(steps.map((step) => [step.ordinal, step]));
  for (const streak of streaks) {
    if (streak.ordinals.some((ordinal) => rerouted.has(ordinal))) continue;
    // The finding sits on the first try whose error shows it, and counts the tries that show the same.
    const readings = streak.ordinals.map((ordinal) => ({
      step: stepAt.get(ordinal)!,
      reading: errorShapeOf(errorOf(stepAt.get(ordinal)!, errors)),
    }));
    const shown = readings.find((entry) => entry.reading !== null);
    if (!shown?.reading) continue;
    const { step: at, reading } = shown;
    if (reading.shape === "unknown_tool" && inCatalog(streak.tool, catalog)) continue;
    if (reading.shape === "unknown_reference" && isProbe(streak.tool)) continue;
    findings.push({
      kind: reading.shape,
      stepOrdinal: at.ordinal,
      toolId: streak.tool,
      requestedToolId: null,
      evidence: reading.evidence,
      repeats: readings.filter((entry) => entry.reading?.shape === reading.shape).length,
      worked: false,
      occurredAt: at.occurredAt,
    });
  }

  // A call that "worked" whose result said the tool does not exist.
  for (const { step, node } of calls) {
    if (step.outcome === "error" || rerouted.has(step.ordinal) || inCatalog(node, catalog))
      continue;
    if (!eventIdsOf(step).some((id) => input.noSuchTool.has(id))) continue;
    findings.push({
      kind: "unknown_tool",
      stepOrdinal: step.ordinal,
      toolId: node,
      requestedToolId: null,
      evidence: "result_no_such_tool",
      repeats: 1,
      worked: false,
      occurredAt: step.occurredAt,
    });
  }

  // "Done" after an acting call failed and nothing of its kind worked after it. One per turn: the reply is one claim.
  const undone = claimsCompletion(input.reply) ? unrecoveredActingFailure(steps) : null;
  if (undone) {
    const first = stepAt.get(undone.ordinals[0]!)!;
    findings.push({
      kind: "claimed_done_after_failure",
      stepOrdinal: first.ordinal,
      toolId: undone.tool,
      requestedToolId: null,
      evidence: "claim_after_failure",
      repeats: undone.ordinals.length,
      worked: false,
      occurredAt: first.occurredAt,
    });
  }

  return findings.sort((a, b) => a.stepOrdinal - b.stepOrdinal || a.kind.localeCompare(b.kind));
}
