import { sql } from "drizzle-orm";
import { loadStoredPropertyNames } from "@/lib/ingest/properties/store";
import type { getDb } from "@/lib/platform/db/client";
import type { RqlTableName } from "@/lib/synthesis/rql/compile";
import { DASHBOARD_TEMPLATES } from "@/lib/views/dashboards/templates";
import type {
  DashboardTemplate,
  TemplateCard,
  TemplateNeed,
} from "@/lib/views/dashboards/templates/types";

/**
 * Whether a project has the data of a template, from cheap facts: one indexed probe per kind of
 * row, the names of the indexed properties and the scorer count. Read for the caller's project
 * only. The check itself is pure (`templateData`).
 */

export interface TemplateFacts {
  /** The RQL tables that hold a row of the project. */
  tables: readonly RqlTableName[];
  /** A span of a tool call. */
  toolCalls: boolean;
  /** A span of a named agent. */
  agents: boolean;
  /** The names of the indexed trace properties. */
  properties: readonly string[];
  scorers: number;
}

/** What the gallery and `list_dashboard_templates` say of one template. */
export interface TemplateData {
  has: boolean;
  /** Why not, in words, one per missing need: "No scores yet". */
  missing: string[];
}

/** The facts of an empty project. */
export const NO_FACTS: TemplateFacts = {
  tables: [],
  toolCalls: false,
  agents: false,
  properties: [],
  scorers: 0,
};

/** Whether the facts hold each need of the template, with the reason of each one that is missing. */
export function templateData(template: DashboardTemplate, facts: TemplateFacts): TemplateData {
  const missing = template.needs.flatMap((need) => {
    const reason = missingReason(need, facts);
    return reason ? [reason] : [];
  });
  return { has: missing.length === 0, missing };
}

/** The gallery's cards, in its order, for the facts of one project. */
export function templateCards(facts: TemplateFacts): TemplateCard[] {
  return DASHBOARD_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    property: template.property,
    ...templateData(template, facts),
  }));
}

/** The facts of one project: one query of probes, the property names and the scorers. */
export async function loadTemplateFacts(
  projectId: string,
  db: Pick<ReturnType<typeof getDb>, "execute">,
): Promise<TemplateFacts> {
  const [probes, properties] = await Promise.all([
    loadDataProbes(projectId, db),
    loadStoredPropertyNames(projectId, db),
  ]);
  return { ...probes, properties: properties.indexed };
}

/** The RQL tables with a row of the project, tool calls, agents and scorers: one indexed probe each. */
export async function loadDataProbes(
  projectId: string,
  db: Pick<ReturnType<typeof getDb>, "execute">,
): Promise<Omit<TemplateFacts, "properties">> {
  const result = await db.execute(sql`
    select
      exists(select 1 from otel_trace_summaries where project_id = ${projectId}::uuid) as traces,
      exists(select 1 from otel_spans where project_id = ${projectId}::uuid) as events,
      exists(select 1 from trace_scores where project_id = ${projectId}::uuid) as scores,
      exists(select 1 from event_metrics where project_id = ${projectId}::uuid) as prompts,
      exists(select 1 from otel_trace_summaries where project_id = ${projectId}::uuid and session_id is not null) as sessions,
      exists(select 1 from otel_trace_summaries where project_id = ${projectId}::uuid and end_user_id is not null) as users,
      exists(select 1 from otel_spans where project_id = ${projectId}::uuid and span_class = 'tool') as tool_calls,
      exists(select 1 from otel_spans where project_id = ${projectId}::uuid and agent_key is not null) as agents,
      (select count(*)::int from trace_scorers where project_id = ${projectId}::uuid) as scorers`);
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as Record<string, unknown>[];
  const [row = {}] = rows;
  const tables = TABLES.filter((table) => row[table] === true);
  return {
    tables,
    toolCalls: row.tool_calls === true,
    agents: row.agents === true,
    scorers: Number(row.scorers ?? 0),
  };
}

const TABLES: readonly RqlTableName[] = [
  "traces",
  "events",
  "scores",
  "prompts",
  "sessions",
  "users",
];

function missingReason(need: TemplateNeed, facts: TemplateFacts): string | null {
  const has = (table: RqlTableName) => facts.tables.includes(table);
  switch (need) {
    case "traces":
      return has("traces") ? null : "No traces yet";
    case "tool_calls":
      return facts.toolCalls ? null : "No tool calls yet";
    case "scores":
      if (has("scores")) return null;
      return facts.scorers === 0 ? "No scorer yet" : "No scores yet";
    case "sessions":
      return has("sessions") ? null : "No sessions yet";
    case "users":
      return has("users") ? null : "No end users yet";
    case "prompts":
      return has("prompts") ? null : "No captured prompts yet";
    case "agents":
      return facts.agents ? null : "No agents yet";
    case "property":
      return facts.properties.length > 0 ? null : "No indexed trace property yet";
  }
}
