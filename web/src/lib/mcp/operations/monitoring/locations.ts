import { z } from "zod";
import { projectSettingsRoot } from "@/lib/console/settings/tabs";
import { changeGeoAttributes } from "@/lib/ingest/geo/actions";
import {
  DEFAULT_GEO_ATTRIBUTES,
  GEO_ATTRIBUTES,
  type GeoAttributes,
} from "@/lib/ingest/geo/attributes";
import { loadGeoAttributes, saveGeoAttributes } from "@/lib/ingest/geo/store";
import { invalidParams } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import {
  callerRole,
  defaultMonitoringDeps,
  type MonitoringDeps,
  observeChange,
  refusal,
  requireMonitoring,
} from "./deps";

/** What each attribute holds, as Settings > General > Location attributes says it. */
export const LOCATION_ATTRIBUTES: Readonly<Record<keyof GeoAttributes, string>> = {
  address: "IP address, resolved and never stored",
  country: "Country code (ISO 3166-1)",
  region: "Region code (ISO 3166-2)",
  latitude: "Latitude in degrees",
  longitude: "Longitude in degrees",
};

export function locationReadOperations(
  deps: MonitoringDeps = defaultMonitoringDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "get_location_attributes",
      domain: "observability",
      title: "Get the location attributes",
      description:
        "The span attributes a project's traces carry their location in: an IP address, a country, a region and coordinates. change_location_attributes changes them; a geography query (query_monitoring) shows the result.",
      keywords: ["location settings", "geo attributes", "ip address attribute"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const { projectId } = await requireMonitoring(deps, ctx);
        const attributes = await loadGeoAttributes(projectId, deps.db());
        return {
          data: shown(projectId, attributes),
          hint: "An organization admin changes them with change_location_attributes.",
        };
      },
    }),
  ];
}

export function locationWriteOperations(
  deps: MonitoringDeps = defaultMonitoringDeps,
): McpOperation[] {
  const name = (key: keyof GeoAttributes) =>
    z.string().max(200).optional().describe(`${LOCATION_ATTRIBUTES[key]}.`);
  return [
    defineOperation({
      id: "change_location_attributes",
      domain: "writes",
      title: "Change the location attributes",
      description:
        "Change the span attributes a project's traces are located by (organization admins only). It changes only the fields it gives, for the traces that arrive about a minute later. An address or a coordinate attribute that spans store (gen_ai.*, ratel.*, server.address) is refused. Read them with get_location_attributes.",
      keywords: ["set location attributes", "change geo attributes"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        address: name("address"),
        country: name("country"),
        region: name("region"),
        latitude: name("latitude"),
        longitude: name("longitude"),
        reset: z.boolean().optional().describe("true: the defaults, but for the fields given."),
      }),
      async execute(ctx, params) {
        const { projectId } = await requireMonitoring(deps, ctx);
        const given = Object.fromEntries(
          GEO_ATTRIBUTES.flatMap((key) => (params[key] === undefined ? [] : [[key, params[key]]])),
        );
        if (Object.keys(given).length === 0 && !params.reset)
          throw invalidParams("Pass at least one attribute, or reset: true.");
        const before = params.reset
          ? DEFAULT_GEO_ATTRIBUTES
          : await loadGeoAttributes(projectId, deps.db());
        const result = await changeGeoAttributes(
          projectId,
          { ...before, ...given },
          {
            findProjectScope: async () => scopeOf(ctx),
            // requireMonitoring let the caller in, and a support session is a browser's.
            enabled: async () => true,
            isRestricted: async () => false,
            save: (id, attributes) => saveGeoAttributes(id, attributes, deps.db()),
            observe: observeChange(deps, ctx, "project_settings_updated"),
          },
        );
        if (!result.ok) throw refusal(result.error);
        return {
          data: shown(projectId, result.attributes),
          hint: "Traces that arrive from about a minute from now are read under these names. Older traces keep their location.",
        };
      },
    }),
  ];
}

function scopeOf(ctx: OperationContext) {
  return {
    project: { id: ctx.projectId },
    organization: { id: ctx.organizationId ?? "" },
    role: callerRole(ctx),
  };
}

function shown(projectId: string, attributes: GeoAttributes) {
  return {
    summary: GEO_ATTRIBUTES.map((key) => `${key}: ${attributes[key]}`).join("; "),
    attributes,
    rows: GEO_ATTRIBUTES.map((key) => ({
      key,
      holds: LOCATION_ATTRIBUTES[key],
      attribute: attributes[key],
      source: attributes[key] === DEFAULT_GEO_ATTRIBUTES[key] ? "default" : "custom",
    })),
    href: projectSettingsRoot(projectId),
  };
}
