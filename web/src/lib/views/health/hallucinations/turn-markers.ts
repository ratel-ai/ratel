import { and, asc, eq } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import {
  GROUP_LABEL,
  GROUP_OF,
  type HallucinationKind,
  KIND_LABEL,
  kindOf,
} from "@/lib/readings/trace-signals/hallucinations/kinds";
import { traceHallucinations } from "@/lib/readings/trace-signals/schema";
import { catalogEntryOf } from "@/lib/readings/trace-signals/self-corrections/issues";
import { hallucinationsHref } from "@/lib/views/health/hallucinations/paths";

/**
 * A turn's hallucinations as the Traces turn view marks them: on the call
 * each one sits on, in words built from the stored values alone (no message
 * text), with the way to that kind on the Hallucinations page.
 */

export interface TurnMarker {
  /** The call's 1-based ordinal in the turn. */
  stepOrdinal: number;
  kind: HallucinationKind;
  group: string;
  label: string;
  /** What the trace shows, in a sentence. */
  detail: string;
  /** The Hallucinations page with this kind open. */
  href: string;
}

type MarkersDb = Pick<ReturnType<typeof getDb>, "select">;

interface StoredFinding {
  stepOrdinal: number;
  kind: string;
  toolId: string;
  requestedToolId: string | null;
  repeats: number;
  worked: boolean;
}

const tries = (n: number): string => (n > 1 ? ` ${n} tries in a row.` : "");

function detailOf(finding: StoredFinding, kind: HallucinationKind): string {
  const tool = catalogEntryOf(finding.toolId).id;
  switch (kind) {
    case "tool_rerouted":
    case "tool_action_changed":
      return `Asked for ${finding.requestedToolId ?? "another tool"}, which is not a tool. ${tool} ran instead${finding.worked ? " and worked" : " and failed"}.${tries(finding.repeats)}`;
    case "unknown_tool":
      return `${tool} is not a tool the agent has.${tries(finding.repeats)}`;
    case "unknown_reference":
      return `${tool} was given a record that does not exist.${tries(finding.repeats)}`;
    case "value_not_allowed":
      return `${tool} was given a value it does not take, and answered with the ones it does.${tries(finding.repeats)}`;
    case "claimed_done_after_failure":
      return `The reply says the work is done, but ${tool} failed and nothing after it made up for it.`;
    case "done_but_person_says_not":
      return "The reply says the work is done; the person's next message says it was not.";
  }
}

/** The markers of stored findings (pure). A kind this version does not know is left out. */
export function turnMarkers(projectId: string, findings: readonly StoredFinding[]): TurnMarker[] {
  return findings.flatMap((finding) => {
    const kind = kindOf(finding.kind);
    if (!kind) return [];
    return [
      {
        stepOrdinal: finding.stepOrdinal,
        kind,
        group: GROUP_LABEL[GROUP_OF[kind]],
        label: KIND_LABEL[kind],
        detail: detailOf(finding, kind),
        href: hallucinationsHref(projectId, { open: kind }),
      },
    ];
  });
}

export async function loadTurnMarkers(
  db: MarkersDb,
  projectId: string,
  turnId: string,
): Promise<TurnMarker[]> {
  const rows = await db
    .select({
      stepOrdinal: traceHallucinations.stepOrdinal,
      kind: traceHallucinations.kind,
      toolId: traceHallucinations.toolId,
      requestedToolId: traceHallucinations.requestedToolId,
      repeats: traceHallucinations.repeats,
      worked: traceHallucinations.worked,
    })
    .from(traceHallucinations)
    .where(
      and(eq(traceHallucinations.projectId, projectId), eq(traceHallucinations.turnId, turnId)),
    )
    .orderBy(asc(traceHallucinations.stepOrdinal), asc(traceHallucinations.kind));
  return turnMarkers(projectId, rows);
}
