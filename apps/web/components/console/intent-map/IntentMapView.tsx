"use client";

import { Autocomplete, type AutocompleteItem } from "@ratel/design-system/autocomplete";
import { IconButton } from "@ratel/design-system/button";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { Maximize2, Minus, Plus } from "lucide-react";
import { useMemo, useRef } from "react";
import {
  AsksPack,
  type AsksPackHandle,
  type AsksRead,
} from "@/components/console/intent-map/AsksPack";
import { IntentFlow } from "@/components/console/intent-map/IntentFlow";
import { IntentMap, type IntentMapHandle } from "@/components/console/intent-map/IntentMap";
import { ToolNetwork, type ToolNetworkHandle } from "@/components/console/intent-map/ToolNetwork";
import { intentKey } from "@/lib/views/intents/map/asks-pack";
import type { IntentMapModel } from "@/lib/views/intents/map/map-model";
import type { ToolStep } from "@/lib/views/intents/map/tool-network";

export type IntentMapLayout = "map" | "asks" | "flow" | "tools";

/** What the Asks lens needs beyond the model: its trees, read by the caller, and where the reader is in them. */
export interface AsksLens {
  read: AsksRead;
  focus: string | null;
  onFocus: (key: string | null) => void;
  onOpenIntent: (topicId: string) => void;
  panelOpen: boolean;
}

/**
 * The map with its controls: find a node, switch between the Map, the Asks
 * (when the caller can read them), the Flow and the Tools of the same data,
 * and zoom. The caller owns selection and the view, so both can live in the
 * URL.
 */
export function IntentMapView({
  model,
  steps,
  selectedId,
  onOpen,
  onClear,
  layout,
  onLayoutChange,
  obscuredRight,
  asks,
}: {
  model: IntentMapModel;
  /** "Came next" counts for the Tools view, when the loader has them. */
  steps?: readonly ToolStep[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onClear: () => void;
  layout: IntentMapLayout;
  onLayoutChange: (layout: IntentMapLayout) => void;
  /** Pixels at the window's right edge the caller's panel covers while a node is open. */
  obscuredRight?: () => number;
  /** The Asks lens; without it the lens is not offered. */
  asks?: AsksLens;
}) {
  const map = useRef<IntentMapHandle>(null);
  const network = useRef<ToolNetworkHandle>(null);
  const asksView = useRef<AsksPackHandle>(null);
  const tools = useMemo<AutocompleteItem[]>(
    () =>
      model.capabilities.map((capability) => ({
        id: capability.id,
        label: capability.name,
        hint: capability.kind === "skill" ? "Skill" : "Tool",
        keywords: [capability.name.replaceAll("_", " ")],
      })),
    [model],
  );
  const intents = useMemo<AutocompleteItem[]>(
    () => model.asks.map((ask) => ({ id: ask.id, label: ask.label, hint: "Intent" })),
    [model],
  );
  const items = useMemo<AutocompleteItem[]>(() => [...intents, ...tools], [intents, tools]);
  const shown: IntentMapLayout = layout === "asks" && !asks ? "map" : layout;
  // The drawing the zoom buttons act on: the map or the tools.
  const view =
    shown === "map" ? map : shown === "tools" ? network : shown === "asks" ? asksView : null;

  return (
    <div className="flex flex-col gap-3" data-intent-map-view={shown}>
      <div role="toolbar" aria-label="Map controls" className="flex flex-wrap items-center gap-2">
        {shown === "asks" && asks ? (
          <Autocomplete
            items={intents}
            label="Find an intent"
            placeholder="Find an intent…"
            empty="No intent matches"
            onPick={(item) => asks.onFocus(intentKey(item.id))}
          />
        ) : shown === "map" ? (
          <Autocomplete
            items={items}
            label="Find an intent or tool"
            placeholder="Find an intent or tool…"
            empty="Nothing on the map matches"
            onPick={(item) => map.current?.flyTo(item.id)}
          />
        ) : shown === "tools" ? (
          <Autocomplete
            items={tools}
            label="Find a tool"
            placeholder="Find a tool…"
            empty="No tool matches"
            onPick={(item) => network.current?.flyTo(item.id)}
          />
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <SegmentedControl
            label="View"
            options={[
              { value: "map", label: "Map" },
              ...(asks ? [{ value: "asks" as const, label: "Asks" }] : []),
              { value: "flow", label: "Flow" },
              { value: "tools", label: "Tools" },
            ]}
            value={shown}
            onValueChange={onLayoutChange}
          />
          {view ? (
            <div className="flex items-center">
              <IconButton
                label="Zoom out"
                size="icon-sm"
                icon={<Minus />}
                onClick={() => view.current?.zoomOut()}
              />
              <IconButton
                label="Zoom in"
                shortcut="⌘ scroll"
                size="icon-sm"
                icon={<Plus />}
                onClick={() => view.current?.zoomIn()}
              />
              <IconButton
                label="Fit to view"
                size="icon-sm"
                icon={<Maximize2 />}
                onClick={() => view.current?.fit()}
              />
            </div>
          ) : null}
        </div>
      </div>
      {shown === "map" ? (
        <IntentMap
          ref={map}
          model={model}
          selectedId={selectedId}
          onOpen={onOpen}
          onClear={onClear}
          obscuredRight={obscuredRight}
        />
      ) : shown === "asks" && asks ? (
        <AsksPack
          ref={asksView}
          model={model}
          read={asks.read}
          focus={asks.focus}
          onFocus={asks.onFocus}
          onOpenIntent={asks.onOpenIntent}
          panelOpen={asks.panelOpen}
          obscuredRight={obscuredRight}
        />
      ) : shown === "tools" ? (
        <ToolNetwork
          ref={network}
          model={model}
          steps={steps}
          selectedId={selectedId}
          onOpen={onOpen}
          onClear={onClear}
          obscuredRight={obscuredRight}
        />
      ) : (
        <IntentFlow model={model} selectedId={selectedId} onOpen={onOpen} />
      )}
    </div>
  );
}
