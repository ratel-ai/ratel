/**
 * The filter of the page an RQL query runs under (a dashboard, Explore): the trace filter of the
 * console, in its own words here, so the domain stays pure. A row is kept when its trace matches,
 * as the metric form keeps it. Each clause of `and` must match too.
 */
export interface RqlPageFilter {
  models?: readonly string[];
  tools?: readonly string[];
  services?: readonly string[];
  environments?: readonly string[];
  agents?: readonly string[];
  mcpServers?: readonly string[];
  /** "failed": a span of the trace failed; "ok": none did. */
  status?: "failed" | "ok";
  minCostUsd?: number;
  minTokens?: number;
  /** Trace properties (ADR-0012): of one name, any of its values; names combine. */
  properties?: Readonly<Record<string, readonly string[]>>;
  and?: readonly RqlPageFilter[];
}

/** The parts of a filter as conditions on the columns of `rql.traces`; empty when it keeps all. */
export function pageFilterConditions(
  filter: RqlPageFilter,
  param: (value: string | number) => string,
): string[] {
  const parts: string[] = [];
  const anyOf = (column: string, values: readonly string[] | undefined) => {
    const kept = cleaned(values);
    if (kept.length > 0)
      parts.push(`(${kept.map((value) => `${param(value)} = any("${column}")`).join(" or ")})`);
  };
  const oneOf = (column: string, values: readonly string[] | undefined) => {
    const kept = cleaned(values);
    if (kept.length > 0) parts.push(`"${column}" in (${kept.map(param).join(", ")})`);
  };
  anyOf("models", filter.models);
  anyOf("tools", filter.tools);
  oneOf("service_name", filter.services);
  oneOf("environment", filter.environments);
  anyOf("agents", filter.agents);
  anyOf("mcp_servers", filter.mcpServers);
  if (filter.status === "failed") parts.push(`"has_error"`);
  if (filter.status === "ok") parts.push(`not "has_error"`);
  const minCostUsd = positive(filter.minCostUsd);
  if (minCostUsd !== null) parts.push(`"cost_usd" >= ${param(minCostUsd)}`);
  const minTokens = positive(filter.minTokens);
  if (minTokens !== null) parts.push(`"input_tokens" + "output_tokens" >= ${param(minTokens)}`);
  for (const [name, values] of Object.entries(filter.properties ?? {})) {
    const kept = cleaned(values);
    // The name is a bound value, as in properties['name'].
    if (kept.length > 0)
      parts.push(`("properties" ->> ${param(name)}) in (${kept.map(param).join(", ")})`);
  }
  for (const clause of filter.and ?? []) parts.push(...pageFilterConditions(clause, param));
  return parts;
}

/** The list columns of `rql.traces` that a page filter names, by the key of the filter. */
const LIST_FILTERS = {
  models: "models",
  tools: "tools",
  agents: "agents",
  mcp_servers: "mcpServers",
} as const satisfies Record<string, keyof RqlPageFilter>;

/**
 * The values each clause of the filter keeps of one list column: one list per clause that names
 * it. A value of `each(list)` must be in each of them, as the metric form groups a filtered list.
 */
export function pageFilterListValues(filter: RqlPageFilter, column: string): string[][] {
  if (!Object.hasOwn(LIST_FILTERS, column)) return [];
  const key = LIST_FILTERS[column as keyof typeof LIST_FILTERS];
  const own = cleaned(filter[key] as readonly string[] | undefined);
  return [
    ...(own.length > 0 ? [own] : []),
    ...(filter.and ?? []).flatMap((clause) => pageFilterListValues(clause, column)),
  ];
}

/** Trimmed, without blanks and repeats: as the console's trace filter reads its values. */
function cleaned(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function positive(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}
