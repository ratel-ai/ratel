import { z } from "zod";
import type { OrgLimitView } from "@/lib/contracts/entitlements";
import type { PropertyState } from "./schema";
import type { TraceProperty } from "./store";

/**
 * Index a trace property, stop it, or erase its stored values: what Settings > General > Trace
 * properties and `change_trace_property` both call. An organization admin, outside a support
 * session. Indexing a key of the user's own is a plan feature
 * (`maxIndexedPropertiesPerProject`), capped at {@link MAX_USER_INDEXED}; a standard property is
 * indexed on every plan.
 */

export type TracePropertyChange =
  | { action: "index"; name: string }
  | { action: "stop"; name: string; erase?: boolean }
  | { action: "erase"; name: string };

/** Why a change was refused: the MCP tool maps it to its error code. */
export type TracePropertyRefusal = "forbidden" | "not_found" | "not_on_plan" | "limit" | "invalid";

export type TracePropertyResult =
  | {
      ok: true;
      property: TraceProperty;
      /** What an erase removed. Absent when nothing was erased. */
      erased?: { spans: number; traces: number };
      /** The stored traces of the raw store's window are being filled. */
      filling?: boolean;
    }
  | { ok: false; reason: TracePropertyRefusal; error: string };

export interface TracePropertyActionDeps {
  findProjectScope(projectId: string): Promise<{
    project: { id: string };
    organization: OrgLimitView;
    role: string | null;
  } | null>;
  /** An admin support session may look but not change. */
  isRestricted(): Promise<boolean>;
  /** The entitlement: how many properties of its own a project of this organization may index. */
  indexLimit(organization: OrgLimitView): number;
  find(projectId: string, name: string): Promise<TraceProperty | null>;
  countUserIndexed(projectId: string): Promise<number>;
  setState(projectId: string, name: string, state: PropertyState): Promise<TraceProperty | null>;
  /** Remove the property's values from the project's spans and trace summaries. */
  erase(projectId: string, name: string): Promise<{ spans: number; traces: number }>;
  /** Start the fill of the traces the raw store still holds. */
  fill(projectId: string, names: string[]): Promise<void>;
  observe(fields: {
    project_id: string;
    organization_id: string;
    field: "trace_properties";
    action: TracePropertyChange["action"];
  }): Promise<void>;
}

/** The most properties of its own a project indexes, whatever the plan answers. */
export const MAX_USER_INDEXED = 20;

const name = z.string().trim().min(1, "Name the property.").max(200);
const changeSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("index"), name }),
  z.strictObject({ action: z.literal("stop"), name, erase: z.boolean().optional() }),
  z.strictObject({ action: z.literal("erase"), name }),
]);

export async function changeTraceProperty(
  projectId: string,
  raw: unknown,
  deps: TracePropertyActionDeps,
): Promise<TracePropertyResult> {
  const scope = await deps.findProjectScope(projectId);
  if (!scope || scope.role !== "admin")
    return refuse("forbidden", "Only organization admins can change the trace properties.");
  if (await deps.isRestricted())
    return refuse("forbidden", "A support session cannot change settings.");
  const parsed = changeSchema.safeParse(raw);
  if (!parsed.success)
    return refuse("invalid", parsed.error.issues[0]?.message ?? "The change is invalid.");
  const change = parsed.data;
  const id = scope.project.id;
  const property = await deps.find(id, change.name);
  if (!property)
    return refuse("not_found", `This project's traces carry no property ${change.name}.`);

  const result = await apply(change, property, id, scope.organization, deps);
  if (result.ok)
    await deps.observe({
      project_id: id,
      organization_id: scope.organization.id,
      field: "trace_properties",
      action: change.action,
    });
  return result;
}

async function apply(
  change: TracePropertyChange,
  property: TraceProperty,
  projectId: string,
  organization: OrgLimitView,
  deps: TracePropertyActionDeps,
): Promise<TracePropertyResult> {
  if (change.action === "index") {
    if (property.state === "indexed") return { ok: true, property };
    if (property.source === "user") {
      const refused = await indexRefusal(projectId, organization, deps);
      if (refused) return refused;
    }
    const indexed = await deps.setState(projectId, property.name, "indexed");
    if (!indexed)
      return refuse("not_found", `This project's traces carry no property ${property.name}.`);
    if (property.column) return { ok: true, property: indexed };
    await deps.fill(projectId, [property.name]);
    return { ok: true, property: indexed, filling: true };
  }
  if (property.column)
    return refuse(
      "invalid",
      `${property.name} is a column of every trace: it is always kept and cannot be stopped.`,
    );
  if (change.action === "erase" && property.state === "indexed")
    return refuse("invalid", `Stop indexing ${property.name} before you erase its values.`);
  const stopped =
    property.state === "indexed"
      ? await deps.setState(projectId, property.name, "detected")
      : property;
  if (!stopped)
    return refuse("not_found", `This project's traces carry no property ${property.name}.`);
  if (change.action === "stop" && !change.erase) return { ok: true, property: stopped };
  const erased = await deps.erase(projectId, property.name);
  // Its values are gone: it holds none any more.
  return { ok: true, property: { ...stopped, indexedAt: null }, erased };
}

/** Null when the plan and the hard cap leave room for one more property of the user's own. */
async function indexRefusal(
  projectId: string,
  organization: OrgLimitView,
  deps: TracePropertyActionDeps,
): Promise<TracePropertyResult | null> {
  const limit = deps.indexLimit(organization) ?? 0;
  if (!(limit > 0))
    return refuse(
      "not_on_plan",
      "Indexing your own trace properties needs a paid plan: this plan indexes 0 of them per project. Standard properties are indexed on every plan.",
    );
  const count = await deps.countUserIndexed(projectId);
  if (count >= MAX_USER_INDEXED)
    return refuse(
      "limit",
      `A project can index at most ${MAX_USER_INDEXED} trace properties of its own. Stop one to index another.`,
    );
  if (count >= limit)
    return refuse(
      "limit",
      `This project indexes ${count} trace properties of its own, and its plan allows ${limit}. Indexing more of your own properties needs a larger paid plan.`,
    );
  return null;
}

function refuse(reason: TracePropertyRefusal, error: string): TracePropertyResult {
  return { ok: false, reason, error };
}
