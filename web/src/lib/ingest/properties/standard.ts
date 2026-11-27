import { MCP_SESSION_KEYS, SESSION_KEYS, USER_KEYS } from "@/lib/ingest/otlp/attr-resolve";
import { GEN_AI } from "@/lib/ingest/otlp/constants";

/**
 * The standard trace properties: one curated list that maps the attribute keys of the
 * instrumentation conventions to one canonical property name. Ingest indexes a standard property
 * at first sight, on every plan, with no action of a person.
 *
 * A standard property with a `column` is a column of `otel_trace_summaries` already: its values
 * are never stored a second time in `properties`.
 */

/** The `otel_trace_summaries` column that holds a standard property. */
export type PropertyColumn =
  | "end_user_id"
  | "session_id"
  | "environment"
  | "models"
  | "service_name";

export interface StandardProperty {
  /** The canonical name: what the console, the MCP tools and RQL call it. */
  name: string;
  /** The attribute keys, in priority order: the first one present gives the value. */
  keys: readonly string[];
  /** The summary column that holds it; null when its values are stored in `properties`. */
  column: PropertyColumn | null;
}

/**
 * The metadata prefixes of the conventions `SESSION_KEYS` and `USER_KEYS` read: a camelCase
 * convention (`<prefix>userId`) and a snake_case one (`<prefix>user_id`).
 */
const CAMEL_METADATA_PREFIXES = [
  "ai.telemetry.metadata.",
  "ai.settings.context.",
  "mastra.metadata.",
] as const;
const SNAKE_METADATA_PREFIXES = ["traceloop.association.properties."] as const;

export const STANDARD_PROPERTIES: readonly StandardProperty[] = [
  { name: "user", keys: USER_KEYS, column: "end_user_id" },
  { name: "session", keys: [...SESSION_KEYS, ...MCP_SESSION_KEYS], column: "session_id" },
  {
    name: "environment",
    keys: ["deployment.environment.name", "deployment.environment"],
    column: "environment",
  },
  { name: "model", keys: [GEN_AI.responseModel, GEN_AI.requestModel], column: "models" },
  { name: "service", keys: ["service.name"], column: "service_name" },
  {
    name: "organization",
    keys: [
      ...spellings(
        ["organization.id", "org.id", "tenant.id", "customer.id", "account.id"],
        ["organizationId", "orgId", "tenantId", "customerId", "accountId"],
        ["organization_id", "org_id", "tenant_id", "customer_id", "account_id"],
      ),
      "organization",
      "tenant",
    ],
    column: null,
  },
  {
    name: "release",
    keys: spellings(
      ["service.version", "app.version", "release"],
      ["release", "appVersion", "serviceVersion"],
      ["release", "app_version", "service_version"],
    ),
    column: null,
  },
];

const BY_KEY: ReadonlyMap<string, StandardProperty> = new Map(
  STANDARD_PROPERTIES.flatMap((property) => property.keys.map((key) => [key, property] as const)),
);
const BY_NAME: ReadonlyMap<string, StandardProperty> = new Map(
  STANDARD_PROPERTIES.map((property) => [property.name, property]),
);

/** The standard property an attribute key gives, or undefined for any other key. */
export function standardPropertyOf(key: string): StandardProperty | undefined {
  return BY_KEY.get(key);
}

/** The standard property of this canonical name, or undefined for a name of the user's own. */
export function standardProperty(name: string): StandardProperty | undefined {
  return BY_NAME.get(name);
}

/** The plain keys first, then each camelCase and snake_case name under every metadata prefix. */
function spellings(
  plain: readonly string[],
  camel: readonly string[],
  snake: readonly string[],
): string[] {
  return [
    ...plain,
    ...CAMEL_METADATA_PREFIXES.flatMap((prefix) => camel.map((name) => prefix + name)),
    ...SNAKE_METADATA_PREFIXES.flatMap((prefix) => snake.map((name) => prefix + name)),
  ];
}
