import { type SQL, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";

/**
 * Who calls the project's MCP servers (RC-778): the harnesses and their
 * versions, the callers' countries, the transports and the protocol versions,
 * read from the client facts ingest writes on the server's own spans
 * (`otel_spans.harness*`, `geo_country`, `mcp_transport`,
 * `mcp_protocol_version`; RC-773, RC-774).
 *
 * Read budget: every query filters `project_id`, `mcp_server` (one or any),
 * `mcp_role = 'provided'` and a `started_at` window, so Postgres reads the
 * partial index `otel_spans_project_mcp_server_started_idx`. The callers wrap
 * each read in a statement timeout.
 *
 * No query here selects `client_ip`: the caller's raw IP is for organization
 * admins only, on the span detail (`lib/traces/queries.ts`).
 */

export interface ClientsWindow {
  since: Date;
  /** Exclusive. */
  until: Date;
  environment?: string | null;
  /** One MCP server (its key); absent, every server the project provides. */
  server?: string | null;
}

/** One harness, or the calls with no harness (`harness: null`, "unknown client"). */
export interface HarnessRow {
  harness: string | null;
  calls: number;
  errors: number;
  errorRate: number;
  sessions: number;
  /** Within the window: when this harness first called. */
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface HarnessVersionRow extends HarnessRow {
  version: string | null;
}

export interface CountryRow {
  /** ISO 3166-1 alpha-2; null when the IP is private, unknown, or not reported. */
  country: string | null;
  calls: number;
  sessions: number;
}

export interface ValueCount {
  value: string | null;
  calls: number;
}

export interface ClientsOverview {
  harnesses: HarnessRow[];
  versions: HarnessVersionRow[];
  countries: CountryRow[];
  transports: ValueCount[];
  protocolVersions: ValueCount[];
  /** The servers the project provides in the window, for the server filter; unfiltered by `server`. */
  servers: string[];
  /** The environments of the window's calls; unfiltered by `environment`. */
  environments: string[];
}

type ReadDb = Pick<ReturnType<typeof getDb>, "execute">;

const MAX_ROWS = 100;
const MAX_FACET_VALUES = 20;
const ENVIRONMENT = sql`coalesce(s.attributes ->> 'deployment.environment.name', s.attributes ->> 'deployment.environment')`;
const IS_ERROR = sql`(s.status_code = 2 or s.attributes ? 'error.type')`;
const SESSION = sql`coalesce(s.mcp_session_id, 'trace:' || s.trace_id)`;

/** The Clients tab in one call: four aggregate scans over the window's provided MCP spans. */
export async function getClientsOverview(
  projectId: string,
  window: ClientsWindow,
  db: ReadDb = getDb(),
): Promise<ClientsOverview> {
  const [harnesses, versions, countries, facets, options] = await Promise.all([
    db.execute(harnessesQuery(projectId, window)).then((r) => rowsOf<StatRow>(r)),
    db
      .execute(harnessVersionsQuery(projectId, window))
      .then((r) => rowsOf<StatRow & { version: string | null }>(r)),
    db.execute(countriesQuery(projectId, window)).then((r) => rowsOf<CountryDbRow>(r)),
    db.execute(clientFacetsQuery(projectId, window)).then((r) => rowsOf<FacetRow>(r)),
    db.execute(clientOptionsQuery(projectId, window)).then((r) => rowsOf<OptionRow>(r)),
  ]);
  const facet = (name: FacetRow["facet"]) =>
    facets
      .filter((row) => row.facet === name)
      .map((row) => ({ value: row.value, calls: Number(row.calls) }));
  const option = (name: OptionRow["kind"]) =>
    options.filter((row) => row.kind === name).map((row) => row.value);
  return {
    harnesses: harnesses.map(toHarnessRow),
    versions: versions.map((row) => ({ ...toHarnessRow(row), version: row.version })),
    countries: countries.map((row) => ({
      country: row.country,
      calls: Number(row.calls),
      sessions: Number(row.sessions),
    })),
    transports: facet("transport"),
    protocolVersions: facet("protocol"),
    servers: option("server"),
    environments: option("environment"),
  };
}

// — Queries, exported for the read-budget test ————————————————————————————————

export function harnessesQuery(projectId: string, window: ClientsWindow): SQL {
  return sql`
    select s.harness, ${STATS}
    from otel_spans s
    where ${providedSpans(projectId, window)}
    group by s.harness
    order by calls desc, s.harness nulls last
    limit ${MAX_ROWS}
  `;
}

export function harnessVersionsQuery(projectId: string, window: ClientsWindow): SQL {
  return sql`
    select s.harness, s.harness_version as version, ${STATS}
    from otel_spans s
    where ${providedSpans(projectId, window)}
    group by s.harness, s.harness_version
    order by s.harness nulls last, first_seen_at desc, calls desc
    limit ${MAX_ROWS}
  `;
}

export function countriesQuery(projectId: string, window: ClientsWindow): SQL {
  return sql`
    select s.geo_country as country, count(*)::int as calls, count(distinct ${SESSION})::int as sessions
    from otel_spans s
    where ${providedSpans(projectId, window)}
    group by s.geo_country
    order by calls desc, s.geo_country nulls last
    limit ${MAX_ROWS}
  `;
}

/** The transport and protocol version splits, one scan for both. */
export function clientFacetsQuery(projectId: string, window: ClientsWindow): SQL {
  return sql`
    select f.facet, f.value, count(*)::int as calls
    from otel_spans s
    cross join lateral (values ('transport', s.mcp_transport), ('protocol', s.mcp_protocol_version)) as f(facet, value)
    where ${providedSpans(projectId, window)}
    group by f.facet, f.value
    order by f.facet, calls desc, f.value nulls last
    limit ${MAX_FACET_VALUES * 2}
  `;
}

/** The server and environment filter options: the window, without the server and environment filters. */
export function clientOptionsQuery(projectId: string, window: ClientsWindow): SQL {
  const base = providedSpans(projectId, { since: window.since, until: window.until });
  return sql`
    (select distinct 'server' as kind, s.mcp_server as value from otel_spans s where ${base} order by value limit ${MAX_FACET_VALUES})
    union all
    (select distinct 'environment' as kind, ${ENVIRONMENT} as value from otel_spans s where ${base} and ${ENVIRONMENT} is not null order by value limit ${MAX_FACET_VALUES})
  `;
}

// — Helpers ——————————————————————————————————————————————————————————————————

const STATS = sql`
  count(*)::int as calls,
  count(*) filter (where ${IS_ERROR})::int as errors,
  count(distinct ${SESSION})::int as sessions,
  min(s.started_at) as first_seen_at,
  max(s.started_at) as last_seen_at`;

interface StatRow {
  harness: string | null;
  calls: number | string;
  errors: number | string;
  sessions: number | string;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
}

interface CountryDbRow {
  country: string | null;
  calls: number | string;
  sessions: number | string;
}

interface FacetRow {
  facet: "transport" | "protocol";
  value: string | null;
  calls: number | string;
}

interface OptionRow {
  kind: "server" | "environment";
  value: string;
}

/** The server's own spans of the window's MCP calls. */
function providedSpans(projectId: string, window: ClientsWindow): SQL {
  const server = window.server
    ? sql`s.mcp_server = ${window.server}`
    : sql`s.mcp_server is not null`;
  const environment = window.environment ? sql` and ${ENVIRONMENT} = ${window.environment}` : sql``;
  return sql`s.project_id = ${projectId} and ${server} and s.mcp_role = 'provided'
    and s.started_at >= ${window.since.toISOString()}::timestamptz and s.started_at < ${window.until.toISOString()}::timestamptz${environment}`;
}

function toHarnessRow(row: StatRow): HarnessRow {
  const calls = Number(row.calls);
  const errors = Number(row.errors);
  return {
    harness: row.harness,
    calls,
    errors,
    errorRate: calls > 0 ? errors / calls : 0,
    sessions: Number(row.sessions),
    firstSeenAt: new Date(row.first_seen_at),
    lastSeenAt: new Date(row.last_seen_at),
  };
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: unknown[] }).rows ?? (result as unknown[])) as T[];
}
