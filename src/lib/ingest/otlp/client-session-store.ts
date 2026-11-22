import { sql } from "drizzle-orm";
import type {
  ClientFacts,
  DetectSource,
  HarnessId,
  McpTransport,
  SessionClientFacts,
} from "@/lib/ingest/otlp/dimensions";
import { getDb } from "@/lib/platform/db/client";

/**
 * The Postgres side of MCP session client facts (RC-773). An `initialize`
 * span names the client of its whole session, and a session's requests arrive
 * as separate exports:
 * - `findSessionClientFacts`: a later export's spans read the facts their
 *   session's stored `initialize` row holds.
 * - `fillSessionClientFacts`: an `initialize` that arrives after its session's
 *   other spans fills the facts those stored rows lack.
 * Both use `otel_spans_project_mcp_session_idx` (migration 0046 here, upstream 0111).
 */

export type ClientSessionDb = Pick<ReturnType<typeof getDb>, "execute">;

export interface ClientSessionStore {
  find: (projectId: string, sessionIds: readonly string[]) => Promise<SessionClientFacts>;
  fill: (projectId: string, sessions: SessionClientFacts) => Promise<void>;
}

interface FactsRow extends Record<string, unknown> {
  mcp_session_id: string;
  harness: string | null;
  harness_raw: string | null;
  harness_version: string | null;
  harness_source: string | null;
  geo_country: string | null;
  mcp_transport: string | null;
  mcp_protocol_version: string | null;
}

/** The store over a database; the real one by default. */
export function clientSessionStore(db: ClientSessionDb = getDb()): ClientSessionStore {
  return {
    find: (projectId, sessionIds) => findSessionClientFacts(db, projectId, sessionIds),
    fill: (projectId, sessions) => fillSessionClientFacts(db, projectId, sessions),
  };
}

/** The facts of each session's first stored `initialize` MCP server row. */
export async function findSessionClientFacts(
  db: ClientSessionDb,
  projectId: string,
  sessionIds: readonly string[],
): Promise<SessionClientFacts> {
  if (sessionIds.length === 0) return new Map();
  const result = await db.execute<FactsRow>(sql`
    select distinct on (mcp_session_id)
      mcp_session_id, harness, harness_raw, harness_version, harness_source, geo_country, mcp_transport, mcp_protocol_version
    from otel_spans
    where project_id = ${projectId}
      and mcp_session_id in (${sql.join(
        sessionIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      and mcp_role = 'provided'
      and attributes ->> 'mcp.method.name' = 'initialize'
    order by mcp_session_id, started_at, span_id`);
  return new Map(result.rows.map((row) => [row.mcp_session_id, factsOf(row)]));
}

/**
 * Fill the session's stored MCP server rows with its `initialize` facts. A
 * harness is replaced only by a stronger source (sdk > semconv > heuristic);
 * the other facts fill only what is null, the country too: no row keeps an IP
 * (RP-138), so a row's own address cannot say its country is set. A filled
 * row gets a new `received_at`, so the summary sweep recomputes its trace.
 */
export async function fillSessionClientFacts(
  db: ClientSessionDb,
  projectId: string,
  sessions: SessionClientFacts,
): Promise<void> {
  for (const [sessionId, facts] of sessions) {
    const stronger = sql`${rank(facts.harnessSource)}::int > (case harness_source when 'sdk' then 3 when 'semconv' then 2 when 'heuristic' then 1 else 0 end)`;
    await db.execute(sql`
      update otel_spans set
        harness = case when ${stronger} then ${facts.harness} else harness end,
        harness_raw = case when ${stronger} then ${facts.harnessRaw} else harness_raw end,
        harness_version = case when ${stronger} then ${facts.harnessVersion} else harness_version end,
        harness_source = case when ${stronger} then ${facts.harnessSource} else harness_source end,
        geo_country = coalesce(geo_country, ${facts.geoCountry}),
        mcp_transport = coalesce(mcp_transport, ${facts.mcpTransport}),
        mcp_protocol_version = coalesce(mcp_protocol_version, ${facts.mcpProtocolVersion}),
        received_at = now()
      where project_id = ${projectId}
        and mcp_session_id = ${sessionId}
        and mcp_role = 'provided'
        and (${stronger}
          or (geo_country is null and ${facts.geoCountry}::text is not null)
          or (mcp_transport is null and ${facts.mcpTransport}::text is not null)
          or (mcp_protocol_version is null and ${facts.mcpProtocolVersion}::text is not null))`);
  }
}

function rank(source: DetectSource | null): number {
  return source === "sdk" ? 3 : source === "semconv" ? 2 : source === "heuristic" ? 1 : 0;
}

function factsOf(row: FactsRow): ClientFacts {
  return {
    harness: row.harness as HarnessId | null,
    harnessRaw: row.harness_raw,
    harnessVersion: row.harness_version,
    harnessSource: row.harness_source as DetectSource | null,
    // No row keeps the IP (RP-138): a stored session gives its country only.
    clientIp: null,
    geoCountry: row.geo_country,
    mcpTransport: row.mcp_transport as McpTransport | null,
    mcpProtocolVersion: row.mcp_protocol_version,
  };
}
