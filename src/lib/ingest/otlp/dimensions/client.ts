import { isIP } from "node:net";
import { attrString } from "@/lib/ingest/otlp/anyvalue";
import { ancestorsOf, firstString } from "@/lib/ingest/otlp/attr-resolve";
import { type GeoLookup, NO_GEO, publicCountryOf } from "@/lib/ingest/otlp/dimensions/geo";
import type { DetectSource } from "@/lib/ingest/otlp/dimensions/keys";
import { isMcpServerSpan, mcpSessionIdOf } from "@/lib/ingest/otlp/dimensions/mcp";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";

/**
 * Who called an MCP server (RC-773): the harness and its version, the client
 * IP, the transport and the MCP protocol version. Only MCP server spans get
 * them: they are the server author's view of the caller.
 *
 * The harness comes from, in this order (`harnessSource`):
 * 1. `sdk`: `mcp.client.name` / `mcp.client.version` on the span itself (the
 *    Ratel SDK's MCP server wrapper, and Sentry, set them).
 * 2. `semconv`: the session's `initialize` span names the client: an
 *    `initialize` in the same export, or one stored by an earlier request.
 * 3. `heuristic`: the User-Agent product, on the span or on the HTTP server
 *    span of the same request (`user_agent.original`, older `http.user_agent`).
 *
 * Stdio servers with no SDK report no client: every fact stays null.
 *
 * The caller's IP stays in memory (RP-138, the owner's decision): ingest reads
 * its country here, and no row, column or attribute stores the IP. A stored
 * session gives its country, not its IP. With `FF_INGEST_STRIP_CLIENT_ADDRESS`
 * on, the route removes the address keys before decode and hands their values
 * over in `stripped`, by span id, for the country only.
 */

/** The normalized harness ids. `other` keeps its raw name in `harnessRaw`. */
export type HarnessId = "claude-code" | "codex" | "opencode" | "cursor" | "vscode" | "other";
/** `stdio` (`network.transport = pipe`) or `http` (`tcp`, `quic`, or an HTTP server span). */
export type McpTransport = "stdio" | "http";

export interface ClientFacts {
  harness: HarnessId | null;
  /** The client name or User-Agent product the harness was read from. */
  harnessRaw: string | null;
  harnessVersion: string | null;
  harnessSource: DetectSource | null;
  /** The caller's IP, in memory only: no row stores it (RP-138). Null from a stored session. */
  clientIp: string | null;
  /**
   * The ISO country of `clientIp` from the local geo file (RC-774); null for a private or unknown
   * address. A span with no address of its own takes its session's.
   */
  geoCountry: string | null;
  mcpTransport: McpTransport | null;
  mcpProtocolVersion: string | null;
}

/** The sender addresses the ingest strip removed, by span id (RP-138): read for the country only. */
export type StrippedAddresses = ReadonlyMap<string, string>;

/** The client facts of an MCP session, by `mcp.session.id`. */
export type SessionClientFacts = ReadonlyMap<string, ClientFacts>;

export const NO_CLIENT_FACTS: ClientFacts = Object.freeze({
  harness: null,
  harnessRaw: null,
  harnessVersion: null,
  harnessSource: null,
  clientIp: null,
  geoCountry: null,
  mcpTransport: null,
  mcpProtocolVersion: null,
});

const KIND_SERVER = 2;
const INITIALIZE = "initialize";
const MAX_RAW = 128;
const MAX_VERSION = 64;
const CLIENT_NAME_KEY = "mcp.client.name";
const CLIENT_VERSION_KEY = "mcp.client.version";
const PROTOCOL_VERSION_KEY = "mcp.protocol.version";
const USER_AGENT_KEYS = ["user_agent.original", "http.user_agent"] as const;
/** The caller's address: stable semconv first, then the older socket and peer keys. */
const CLIENT_ADDRESS_KEYS = ["client.address", "net.sock.peer.addr", "net.peer.ip"] as const;
const HTTP_SERVER_KEYS = [
  "http.request.method",
  "http.method",
  "http.route",
  "http.target",
  "url.path",
] as const;
/** Sentry's `mcp.transport` values, next to the semconv `network.transport` ones. */
const TRANSPORTS: Readonly<Record<string, McpTransport>> = {
  pipe: "stdio",
  stdio: "stdio",
  tcp: "http",
  quic: "http",
  http: "http",
  sse: "http",
  "streamable-http": "http",
};
const HARNESS_PATTERNS: ReadonlyArray<[RegExp, HarnessId]> = [
  [/claude[-_ ]?code/i, "claude-code"],
  [/^codex/i, "codex"],
  [/opencode/i, "opencode"],
  [/cursor/i, "cursor"],
  [/^(?:visual studio code|vs ?code)/i, "vscode"],
];

/**
 * The client facts of every MCP server span of the export, by span id.
 * `stored` holds the facts of sessions whose `initialize` an earlier request
 * stored (`sessionsToLookUp` names them); an `initialize` in this export wins.
 * `geo` gives the final client IP of each span its country. `stripped` holds
 * the address the ingest strip removed from a span (span id to IP), if any.
 */
export function deriveClientFacts(
  spans: readonly DecodedSpan[],
  index: ReadonlyMap<string, DecodedSpan>,
  stored: SessionClientFacts = new Map(),
  geo: GeoLookup = NO_GEO,
  stripped: StrippedAddresses = new Map(),
): Map<string, ClientFacts> {
  const servers = spans.filter((span) => span.spanId && isMcpServerSpan(span));
  const httpByTrace = httpServerSpansByTrace(spans);
  const ownFacts = new Map<string, ClientFacts>();
  for (const span of servers)
    ownFacts.set(span.spanId, ownFactsOf(span, httpSpanOf(span, index, httpByTrace), stripped));

  const sessions = new Map<string, ClientFacts>();
  for (const [id, facts] of stored) sessions.set(id, inherited(facts));
  for (const span of servers) {
    const session = mcpSessionIdOf(span);
    if (session && isInitialize(span)) sessions.set(session, inherited(ownFacts.get(span.spanId)!));
  }

  const countryOf = publicCountryOf(geo);
  const out = new Map<string, ClientFacts>();
  for (const span of servers) {
    const session = mcpSessionIdOf(span);
    const facts = withSession(
      ownFacts.get(span.spanId)!,
      session ? sessions.get(session) : undefined,
    );
    // No IP here: a stored session's country (RP-138).
    const geoCountry = facts.clientIp ? countryOf(facts.clientIp) : facts.geoCountry;
    out.set(span.spanId, { ...facts, geoCountry });
  }
  return out;
}

/** The sessions of the export's MCP server spans whose `initialize` is not in the export, in order of appearance. */
export function sessionsToLookUp(spans: readonly DecodedSpan[]): string[] {
  const initialized = new Set<string>();
  const used: string[] = [];
  for (const span of spans) {
    if (!isMcpServerSpan(span)) continue;
    const session = mcpSessionIdOf(span);
    if (!session) continue;
    if (isInitialize(span)) initialized.add(session);
    else if (!used.includes(session)) used.push(session);
  }
  return used.filter((session) => !initialized.has(session));
}

/** The `initialize` spans' session facts of the export, to fill spans stored before them. */
export function initializedSessions(
  spans: readonly DecodedSpan[],
  facts: ReadonlyMap<string, ClientFacts>,
): Map<string, ClientFacts> {
  const out = new Map<string, ClientFacts>();
  for (const span of spans) {
    const session = mcpSessionIdOf(span);
    const own = facts.get(span.spanId);
    if (session && own && isInitialize(span) && hasFacts(own)) out.set(session, inherited(own));
  }
  return out;
}

/**
 * The sender address of each span that has one, by span id: what the ingest strip
 * removes (RP-138). The route reads it from the body before the strip, for the country only.
 */
export function senderAddresses(spans: readonly DecodedSpan[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const span of spans) {
    const ip = span.spanId ? addressOf(span) : null;
    if (ip) out.set(span.spanId, ip);
  }
  return out;
}

/** The normalized harness of a client name or User-Agent product. */
export function harnessOf(raw: string): HarnessId {
  return HARNESS_PATTERNS.find(([pattern]) => pattern.test(raw.trim()))?.[1] ?? "other";
}

/** The first product token of a User-Agent and its version: `claude-code/2.1.3 (cli)` is `claude-code`, `2.1.3`. */
export function userAgentProduct(
  userAgent: string | null | undefined,
): { name: string; version: string | null } | null {
  const token = userAgent?.trim().split(/\s/, 1)[0];
  if (!token) return null;
  const [name, version] = token.split("/", 2);
  if (!name) return null;
  return { name, version: version || null };
}

function ownFactsOf(
  span: DecodedSpan,
  http: DecodedSpan | null,
  stripped: StrippedAddresses,
): ClientFacts {
  const address = (of: DecodedSpan) => addressOf(of) ?? stripped.get(of.spanId) ?? null;
  const name = attrString(span.attributes, CLIENT_NAME_KEY)?.trim();
  const product = name
    ? null
    : userAgentProduct(
        firstString(span.attributes, USER_AGENT_KEYS) ??
          (http ? firstString(http.attributes, USER_AGENT_KEYS) : undefined),
      );
  const rawName = name || product?.name;
  const transport =
    TRANSPORTS[
      (
        attrString(span.attributes, "network.transport") ??
        attrString(span.attributes, "mcp.transport") ??
        ""
      ).toLowerCase()
    ];
  return {
    harness: rawName ? harnessOf(rawName) : null,
    harnessRaw: bounded(rawName, MAX_RAW),
    harnessVersion: bounded(
      name ? attrString(span.attributes, CLIENT_VERSION_KEY) : product?.version,
      MAX_VERSION,
    ),
    harnessSource: name ? "sdk" : rawName ? "heuristic" : null,
    clientIp: address(span) ?? (http ? address(http) : null),
    geoCountry: null,
    mcpTransport: transport ?? (http ? "http" : null),
    mcpProtocolVersion: bounded(attrString(span.attributes, PROTOCOL_VERSION_KEY), MAX_VERSION),
  };
}

/** The span's own facts, with the session's for the ones it lacks. A session's client name wins over a User-Agent. */
function withSession(own: ClientFacts, session: ClientFacts | undefined): ClientFacts {
  if (!session) return own;
  const sessionHarness =
    session.harness !== null &&
    (own.harness === null ||
      (own.harnessSource === "heuristic" && session.harnessSource !== "heuristic"));
  return {
    ...(sessionHarness ? pickHarness(session) : pickHarness(own)),
    clientIp: own.clientIp ?? session.clientIp,
    geoCountry: own.clientIp ? null : session.geoCountry,
    mcpTransport: own.mcpTransport ?? session.mcpTransport,
    mcpProtocolVersion: own.mcpProtocolVersion ?? session.mcpProtocolVersion,
  };
}

/** A session's facts as other spans take them: a client name the `initialize` span carried is the handshake's, so `semconv`. */
function inherited(facts: ClientFacts): ClientFacts {
  return facts.harnessSource === "sdk" ? { ...facts, harnessSource: "semconv" } : facts;
}

function pickHarness(
  facts: ClientFacts,
): Pick<ClientFacts, "harness" | "harnessRaw" | "harnessVersion" | "harnessSource"> {
  return {
    harness: facts.harness,
    harnessRaw: facts.harnessRaw,
    harnessVersion: facts.harnessVersion,
    harnessSource: facts.harnessSource,
  };
}

function hasFacts(facts: ClientFacts): boolean {
  return Object.values(facts).some((value) => value !== null);
}

function isInitialize(span: DecodedSpan): boolean {
  return attrString(span.attributes, "mcp.method.name") === INITIALIZE;
}

function httpServerSpansByTrace(spans: readonly DecodedSpan[]): Map<string, DecodedSpan[]> {
  const out = new Map<string, DecodedSpan[]>();
  for (const span of spans) {
    if (!isHttpServerSpan(span)) continue;
    const list = out.get(span.traceId) ?? [];
    list.push(span);
    out.set(span.traceId, list);
  }
  return out;
}

/**
 * The HTTP server span of the MCP span's request: its nearest HTTP server
 * ancestor, or else the tightest HTTP server span of the same trace that
 * encloses it in time (the MCP span's parent can be the caller's span, sent in
 * the request's `_meta`).
 */
function httpSpanOf(
  span: DecodedSpan,
  index: ReadonlyMap<string, DecodedSpan>,
  httpByTrace: ReadonlyMap<string, DecodedSpan[]>,
): DecodedSpan | null {
  const ancestor = ancestorsOf(span, index).find(isHttpServerSpan);
  if (ancestor) return ancestor;
  const enclosing = (httpByTrace.get(span.traceId) ?? []).filter(
    (http) => http.startUnixMs <= span.startUnixMs && http.endUnixMs >= span.endUnixMs,
  );
  return enclosing.sort((a, b) => b.startUnixMs - a.startUnixMs)[0] ?? null;
}

function isHttpServerSpan(span: DecodedSpan): boolean {
  return (
    span.kind === KIND_SERVER &&
    !isMcpServerSpan(span) &&
    HTTP_SERVER_KEYS.some((key) => span.attributes[key] !== undefined)
  );
}

function addressOf(span: DecodedSpan): string | null {
  for (const key of CLIENT_ADDRESS_KEYS) {
    const value = attrString(span.attributes, key)?.trim();
    if (value && isIP(value) !== 0) return value;
  }
  return null;
}

function bounded(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}
