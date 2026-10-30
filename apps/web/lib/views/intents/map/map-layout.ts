/**
 * Where everything sits on the intent map, worked out once per model, before
 * the first paint, and the same every time for the same model.
 *
 * Each group gets a core as large as it is busy (its name sits there), a ring
 * just outside the core for the tools it holds, and a round body around both.
 * The groups are packed so that the groups sharing a tool meet around it and
 * groups sharing nothing keep a gap (`packMap`); then every tool is placed by
 * how many groups it answers (`placeMap`): inside its one group's blob, in the
 * overlap of its two or three, or outside every blob, between the groups it
 * serves. The space is about the size of the view, so the first, fitted view
 * is close to actual size; nothing moves afterwards unless the reader pans.
 */
import { radiusFor } from "@/lib/views/intents/map/map-geometry";
import {
  CORE_RADIUS,
  GAP,
  groupRings,
  type MapLayout,
  TOOL_RADIUS,
  toolMemberships,
  WIDE_CLEAR,
} from "@/lib/views/intents/map/map-membership";
import type { IntentMapModel } from "@/lib/views/intents/map/map-model";
import { packMap } from "@/lib/views/intents/map/map-pack";
import { heldTools, placeMap, type ToolSpot } from "@/lib/views/intents/map/map-placement";

/** The space is the view, or larger when the blobs would crowd it. */
const FILL = 0.42;
/** The smallest space laid out, whatever the view (a phone is about 340 wide). */
const MIN_SPACE = { width: 320, height: 360 };

export function layoutSpace(
  view: { width: number; height: number },
  area: number,
): { width: number; height: number } {
  const width = Math.max(view.width, MIN_SPACE.width);
  const height = Math.max(view.height, MIN_SPACE.height);
  const scale = Math.max(1, Math.sqrt(area / FILL / (width * height)));
  return { width: width * scale, height: height * scale };
}

export function computeMapLayout(
  model: IntentMapModel,
  view: { width: number; height: number },
): MapLayout {
  const askIds = new Set(model.asks.map((ask) => ask.id));
  const links = model.links.filter((link) => askIds.has(link.ask));
  const memberships = toolMemberships(links);
  const maxVolume = Math.max(1, ...model.asks.map((ask) => ask.volume));
  const maxCalls = Math.max(1, ...model.capabilities.map((capability) => capability.calls));
  // Busiest first (the model's order), so the busiest tools take the best spots.
  const tools: ToolSpot[] = model.capabilities.flatMap((capability) => {
    const membership = memberships.get(capability.id);
    return membership
      ? [
          {
            id: capability.id,
            kind: capability.kind,
            r: radiusFor(capability.calls, maxCalls, TOOL_RADIUS),
            ...membership,
          },
        ]
      : [];
  });
  const calls = new Map(model.capabilities.map((capability) => [capability.id, capability.calls]));
  const held = heldTools(tools);
  const groups = model.asks.map((ask) => {
    const core = radiusFor(ask.volume, maxVolume, CORE_RADIUS);
    return {
      id: ask.id,
      ...groupRings(
        core,
        (held.get(ask.id) ?? []).map((tool) => tool.r),
      ),
    };
  });

  const area =
    groups.reduce((sum, group) => sum + Math.PI * (group.reach + GAP) ** 2, 0) +
    tools
      .filter((tool) => tool.membership === "wide")
      .reduce((sum, tool) => sum + Math.PI * (tool.r + WIDE_CLEAR * 2) ** 2, 0);
  const space = layoutSpace(view, area);
  const holding = tools.filter((tool) => tool.membership !== "wide");
  const packed = packMap(
    groups,
    holding.map((tool) => ({
      id: tool.id,
      r: tool.r,
      weight: calls.get(tool.id) ?? 0,
      groups: tool.groups,
    })),
    { x: space.width / 2, y: space.height / 2 },
    GAP,
    space.width / space.height,
  );
  return placeMap(
    groups.map((group) => ({ id: group.id, ...packed.groups.get(group.id)!, r: group.core })),
    tools.map((tool) => ({ ...tool, hint: packed.tools.get(tool.id) })),
    space,
  );
}
