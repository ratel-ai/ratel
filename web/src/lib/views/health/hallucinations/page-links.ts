import {
  GROUP_LABEL,
  GROUP_MEANING,
  type HallucinationGroup,
  type HallucinationKind,
  KIND_LABEL,
  KIND_MEANING,
} from "@/lib/readings/trace-signals/hallucinations/kinds";
import { catalogEntryOf } from "@/lib/readings/trace-signals/self-corrections/issues";
import { turnTracesHref } from "@/lib/readings/trace-signals/view";
import type {
  GroupRow,
  HallucinationsPageModel,
  KindRow,
  KindTool,
} from "@/lib/views/health/hallucinations/page-model";
import { hallucinationsHref } from "@/lib/views/health/hallucinations/paths";

/**
 * The page model with its words and links built, so the client components
 * take plain data: each group as a choice that narrows the page (or lets go
 * when it is the active one), each kind as a narrower choice inside its
 * group, with its tools named and its occurrences as links into Traces,
 * ringed on the call.
 */

export interface ToolView extends KindTool {
  toolName: string;
  requestedName: string | null;
}

export interface ExampleView {
  turnId: string;
  occurredAt: string;
  /** The turn in Traces, on the call the finding sits on. */
  traceHref: string;
}

export interface KindView extends Omit<KindRow, "tools" | "examples"> {
  label: string;
  meaning: string;
  groupLabel: string;
  /** The page narrowed to this kind, or back to its whole group when it is the active one. */
  href: string;
  active: boolean;
  tools: ToolView[];
  examples: ExampleView[];
}

export interface GroupView extends Omit<GroupRow, "kinds"> {
  label: string;
  meaning: string;
  /** The page narrowed to this group; every group when it is the active one with no kind picked. */
  href: string;
  active: boolean;
  /** Whether following `href` leaves this group picked, so its kinds stay open. */
  staysPicked: boolean;
  kinds: KindView[];
}

export interface HallucinationsLinks {
  /** Every group, in their fixed order. */
  groups: GroupView[];
  /** The groups the table lists: the active one (with only the picked kind, when there is one), or all with an occurrence. */
  listed: GroupView[];
  /** The page with no group picked. */
  allHref: string;
  activeGroup: HallucinationGroup | null;
  activeKind: HallucinationKind | null;
}

export function hallucinationsLinks(model: HallucinationsPageModel): HallucinationsLinks {
  const { projectId, windowDays: days, query } = model;
  const groups = model.groups.map((group): GroupView => {
    const active = query.group === group.group;
    // Picking the active group again lets go of it, unless a kind is picked: then it widens back to the group.
    const staysPicked = !active || query.kind !== null;
    return {
      ...group,
      label: GROUP_LABEL[group.group],
      meaning: GROUP_MEANING[group.group],
      href: hallucinationsHref(projectId, { days, group: staysPicked ? group.group : null }),
      active,
      staysPicked,
      kinds: group.kinds.map((kind) => ({
        ...kind,
        label: KIND_LABEL[kind.kind],
        meaning: KIND_MEANING[kind.kind],
        groupLabel: GROUP_LABEL[group.group],
        href: hallucinationsHref(
          projectId,
          query.kind === kind.kind ? { days, group: group.group } : { days, kind: kind.kind },
        ),
        active: query.kind === kind.kind,
        tools: kind.tools.map((tool) => ({
          ...tool,
          toolName: catalogEntryOf(tool.toolId).id,
          requestedName: tool.requestedToolId,
        })),
        examples: kind.examples.map((example) => ({
          turnId: example.turnId,
          occurredAt: example.occurredAt,
          traceHref: turnTracesHref(projectId, example.turnId, example.eventId),
        })),
      })),
    };
  });
  return {
    groups,
    listed: groups
      .filter((group) => group.occurrences > 0 && (query.group === null || group.active))
      .map((group) =>
        query.kind === null
          ? group
          : { ...group, kinds: group.kinds.filter((kind) => kind.active) },
      )
      .filter((group) => group.kinds.length > 0),
    allHref: hallucinationsHref(projectId, { days }),
    activeGroup: query.group,
    activeKind: query.kind,
  };
}
