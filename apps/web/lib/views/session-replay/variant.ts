import { createHash } from "node:crypto";
import { emptyChange, parseChange } from "@/lib/views/eval-gate/change";
import type { CraftedToolDef, FixChange, ToolDef } from "@/lib/views/eval-gate/types";

/**
 * One What-if change (RC-175): what the user forks a step with. Each kind
 * comes from a row the project already has:
 *
 * - `fix`: a fix as `changeOf(fix, fix_drafts.change)` reads it;
 * - `tool_craft`: the crafted definitions of a `tool_craft_proposals` row;
 * - `catalog_override`: `runtime_catalog_entries.searchable_description_override`;
 * - `definition`: a tool's edited definition (description and argument schema);
 * - `add_tool` / `remove_tool`: a tool offered or taken away.
 *
 * A variant holds definitions only, never conversation text.
 */

export type Variant =
  | { kind: "fix"; change: FixChange }
  | { kind: "tool_craft"; tools: CraftedToolDef[] }
  | { kind: "catalog_override"; tool: string; searchable: string }
  | { kind: "definition"; tool: ToolDef }
  | { kind: "add_tool"; tool: ToolDef }
  | { kind: "remove_tool"; tool: string };

export type VariantKind = Variant["kind"];

export const VARIANT_KINDS: readonly VariantKind[] = [
  "fix",
  "tool_craft",
  "catalog_override",
  "definition",
  "add_tool",
  "remove_tool",
];

/** A stable key for one variant: the same change gives the same key, whatever its key order. */
export function variantKey(variant: Variant): string {
  return createHash("sha256")
    .update(JSON.stringify(sorted(variant)))
    .digest("hex")
    .slice(0, 32);
}

/** A variant read back from a job's payload, strictly; null when it is malformed. */
export function parseVariant(value: unknown): Variant | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "fix":
      return record.change && typeof record.change === "object"
        ? { kind: "fix", change: parseChange(record.change) }
        : null;
    case "tool_craft": {
      const tools = Array.isArray(record.tools) ? record.tools.map(toolDefOf) : [];
      if (tools.length === 0 || tools.some((tool) => tool === null)) return null;
      return {
        kind: "tool_craft",
        tools: tools.map((tool, i) => ({
          ...tool!,
          replaces: stringsOf((record.tools as Record<string, unknown>[])[i]!.replaces),
        })),
      };
    }
    case "catalog_override":
      return typeof record.tool === "string" && typeof record.searchable === "string"
        ? { kind: "catalog_override", tool: record.tool, searchable: record.searchable }
        : null;
    case "definition":
    case "add_tool": {
      const tool = toolDefOf(record.tool);
      return tool ? { kind: record.kind, tool } : null;
    }
    case "remove_tool":
      return typeof record.tool === "string" ? { kind: "remove_tool", tool: record.tool } : null;
    default:
      return null;
  }
}

/**
 * The variant as the change a re-rank applies (`createRanker`): a new
 * searchable text, a tool that joins or leaves the catalog.
 */
export function rerankChange(variant: Variant): FixChange {
  const change = emptyChange();
  switch (variant.kind) {
    case "fix":
      return variant.change;
    case "tool_craft":
      for (const tool of variant.tools) {
        if (tool.replaces.length === 0) change.patches[tool.name] = tool.description;
        else {
          change.add.push({
            id: tool.name,
            name: tool.name,
            searchable: tool.description,
            replaces: [...tool.replaces],
          });
          change.hide.push(...tool.replaces.filter((name) => !change.hide.includes(name)));
        }
      }
      return change;
    case "catalog_override":
      change.patches[variant.tool] = variant.searchable;
      return change;
    case "definition":
      change.patches[variant.tool.name] = variant.tool.description;
      return change;
    case "add_tool":
      change.add.push({
        id: variant.tool.name,
        name: variant.tool.name,
        searchable: variant.tool.description,
        replaces: [],
      });
      return change;
    case "remove_tool":
      change.hide.push(variant.tool);
      return change;
  }
}

function toolDefOf(value: unknown): ToolDef | null {
  if (!value || typeof value !== "object") return null;
  const tool = value as Record<string, unknown>;
  if (typeof tool.name !== "string" || !tool.name || typeof tool.description !== "string")
    return null;
  const parameters =
    tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
      ? (tool.parameters as Record<string, unknown>)
      : { type: "object", properties: {} };
  return { name: tool.name, description: tool.description, parameters };
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}
