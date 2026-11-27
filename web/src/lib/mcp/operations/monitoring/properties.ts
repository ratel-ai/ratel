import { z } from "zod";
import { projectSettingsRoot } from "@/lib/console/settings/tabs";
import type { OrgLimitView } from "@/lib/contracts/entitlements";
import { changeTraceProperty, type TracePropertyRefusal } from "@/lib/ingest/properties/actions";
import { listTraceProperties, type TraceProperty } from "@/lib/ingest/properties/store";
import { forbidden, invalidParams, McpOperationError } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { tracePropertyStorage } from "@/lib/synthesis/traces/property-storage";
import {
  callerRole,
  defaultMonitoringDeps,
  type MonitoringDeps,
  observeChange,
  requireMonitoring,
} from "./deps";

/**
 * The trace properties of a project (RTL-395), as Settings > General > Trace properties shows
 * and changes them: `list_trace_properties` and `change_trace_property`. The change calls the
 * console's own action (`changeTraceProperty`).
 */

export interface PropertyOperationDeps {
  storage(db: ReturnType<MonitoringDeps["db"]>): ReturnType<typeof tracePropertyStorage>;
  /** The organization the entitlement is read from. */
  organization(projectId: string): Promise<OrgLimitView | null>;
}

export const defaultPropertyOperationDeps: PropertyOperationDeps = {
  storage: (db) => tracePropertyStorage(db),
  organization: (projectId) => getOrganizationByProjectId(projectId),
};

const SOURCES = {
  standard: "standard: Ratel indexes it on every plan",
  user: "your own: indexing it is a paid-plan feature",
} as const;

export function propertyReadOperations(
  deps: MonitoringDeps = defaultMonitoringDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "list_trace_properties",
      domain: "observability",
      title: "List the trace properties",
      description:
        "The attribute keys a project's traces carry, each with its state (indexed: Ratel stores its value on every trace, for filters and group-bys; detected: only the key name is known) and its source (standard: indexed on every plan; user: the project's own key, indexed by a person). change_trace_property indexes, stops or erases one.",
      keywords: ["trace properties", "custom properties", "attributes", "indexed keys"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const { projectId } = await requireMonitoring(deps, ctx);
        const properties = await listTraceProperties(projectId, deps.db());
        return {
          data: shown(projectId, properties),
          hint: "An organization admin indexes a detected key, or stops or erases one, with change_trace_property.",
        };
      },
    }),
  ];
}

export function propertyWriteOperations(
  deps: MonitoringDeps = defaultMonitoringDeps,
  propertyDeps: PropertyOperationDeps = defaultPropertyOperationDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "change_trace_property",
      domain: "writes",
      title: "Change a trace property",
      description:
        "Index, stop or erase a trace property (organization admins only). index: new traces keep its value and stored ones are filled; a key of the project's own needs a paid plan (at most 20), a standard one is on every plan. stop: no new values (erase: true removes the stored ones too). erase: removes the stored values of a stopped one. List them with list_trace_properties.",
      keywords: ["index property", "stop indexing", "erase property values", "custom property"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        action: z.enum(["index", "stop", "erase"]),
        name: z
          .string()
          .min(1)
          .max(200)
          .describe("The property, as list_trace_properties names it."),
        erase: z.boolean().optional().describe("With stop: also erase the stored values."),
      }),
      async execute(ctx, params) {
        const { projectId } = await requireMonitoring(deps, ctx);
        if (params.erase !== undefined && params.action !== "stop")
          throw invalidParams("erase goes with action stop only.");
        const change =
          params.action === "stop"
            ? { action: params.action, name: params.name, erase: params.erase }
            : { action: params.action, name: params.name };
        const result = await changeTraceProperty(projectId, change, {
          ...propertyDeps.storage(deps.db()),
          findProjectScope: async () => scopeOf(ctx, propertyDeps),
          // requireMonitoring let the caller in, and a support session is a browser's.
          enabled: async () => true,
          isRestricted: async () => false,
          observe: observeChange(deps, ctx, "project_settings_updated"),
        });
        if (!result.ok) throw refusalOf(result.reason, result.error);
        const done = result.erased
          ? `${result.property.name}: erased from ${result.erased.traces} traces and ${result.erased.spans} spans.`
          : `${result.property.name}: ${result.property.state}.`;
        return {
          data: {
            summary: result.filling ? `${done} The stored traces are being filled.` : done,
            property: row(result.property),
            ...(result.erased ? { erased: result.erased } : {}),
            filling: result.filling ?? false,
            href: projectSettingsRoot(projectId),
          },
          hint: "list_trace_properties shows every property and its state.",
        };
      },
    }),
  ];
}

async function scopeOf(ctx: OperationContext, deps: PropertyOperationDeps) {
  const organization = (await deps.organization(ctx.projectId)) ?? { id: ctx.organizationId ?? "" };
  return { project: { id: ctx.projectId }, organization, role: callerRole(ctx) };
}

/** The action's refusal as the tool's error: a plan refusal is a quota, with its reason. */
function refusalOf(reason: TracePropertyRefusal, message: string): McpOperationError {
  if (reason === "forbidden") return forbidden(message);
  if (reason === "not_found") return new McpOperationError("not_found", message);
  if (reason === "not_on_plan" || reason === "limit")
    return new McpOperationError("quota_exceeded", message, { reason });
  return invalidParams(message);
}

function shown(projectId: string, properties: readonly TraceProperty[]) {
  const indexed = properties.filter((property) => property.state === "indexed");
  return {
    summary:
      properties.length === 0
        ? "No trace property yet: keys show up once traces arrive."
        : `${properties.length} trace properties, ${indexed.length} indexed: ${indexed.map((property) => property.name).join(", ") || "none"}.`,
    count: properties.length,
    rows: properties.map(row),
    href: projectSettingsRoot(projectId),
  };
}

function row(property: TraceProperty) {
  return {
    name: property.name,
    state: property.state,
    source: property.source,
    sourceMeans: SOURCES[property.source],
    column: property.column,
    lastSeenAt: property.lastSeenAt.toISOString(),
    seenCount: property.seenCount,
    valuesStored: property.indexedAt !== null && property.column === null,
  };
}
