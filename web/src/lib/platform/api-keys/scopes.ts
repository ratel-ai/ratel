/**
 * What a project API key may do (RC-585).
 *
 * A key carries a list of scopes, one per bearer surface. Every route checks its
 * own scope server-side (`resolveProjectFromBearer(req, scope)` and
 * `authenticateApiKey`), so a key reaches exactly the surfaces it was given and
 * nothing else. The key's prefix (`rtl_pub_`) is only a label for people and
 * secret scanners; it is never what decides access.
 *
 * `*` means "every scope, present and future": it is what every key issued
 * before scopes existed holds (migration 0096), and what a Full key gets, so a
 * Full key keeps behaving exactly as keys always have, including on a surface
 * added later. The narrower presets are stored as explicit lists, so a new
 * scope is never granted to them by accident.
 */

export const API_KEY_SCOPES = [
  "ingest:traces",
  "ingest:logs",
  "ingest:events",
  "catalog:read",
  "catalog:write",
  "skills:read",
  "skills:write",
  "runtime_catalog:read",
  "jobs:read",
  "intent_graph:read",
  "intent_graph:write",
  "embeddings",
  "tool_picker",
  "mcp:read",
  "mcp:write",
  "content:read",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** The stored value that grants every scope. */
export const ALL_SCOPES = "*";

export type StoredApiKeyScope = ApiKeyScope | typeof ALL_SCOPES;

type ScopeInfo = { label: string; description: string; group: ScopeGroup };
export type ScopeGroup = "Ingest" | "Catalog" | "Runtime" | "Usage" | "MCP";

/** Labels for the advanced picker and the 403 reason. Plain words, no engine names. */
export const API_KEY_SCOPE_INFO: Readonly<Record<ApiKeyScope, ScopeInfo>> = {
  "ingest:traces": {
    group: "Ingest",
    label: "Send traces",
    description: "POST /v1/traces (OTLP spans)",
  },
  "ingest:logs": { group: "Ingest", label: "Send logs", description: "POST /v1/logs (OTLP logs)" },
  "ingest:events": {
    group: "Ingest",
    label: "Send runtime events",
    description: "POST /api/v1/events",
  },
  "catalog:read": {
    group: "Catalog",
    label: "Read the skill catalog",
    description: "GET /v1/catalog and /v2/catalog",
  },
  "catalog:write": {
    group: "Catalog",
    label: "Sync the tool catalog",
    description: "PUT /v1/catalog/snapshot",
  },
  "skills:read": { group: "Catalog", label: "Read skills", description: "GET /api/v1/skills" },
  "skills:write": {
    group: "Catalog",
    label: "Change skills",
    description: "Create, edit, import, publish and archive skills",
  },
  "runtime_catalog:read": {
    group: "Runtime",
    label: "Read runtime catalog overrides",
    description: "GET /v1/runtime-catalog/overrides",
  },
  "jobs:read": { group: "Runtime", label: "Read job status", description: "GET /api/v1/jobs/:id" },
  "intent_graph:read": {
    group: "Runtime",
    label: "Read the intent graph",
    description: "GET /v1/intent-graph",
  },
  "intent_graph:write": {
    group: "Runtime",
    label: "Save the intent graph",
    description: "PUT /v1/intent-graph",
  },
  embeddings: {
    group: "Usage",
    label: "Embeddings",
    description: "POST /v1/embeddings, spends embedding credit",
  },
  tool_picker: {
    group: "Usage",
    label: "Tool Picker",
    description: "POST /v1/tools/pick, spends Tool Picker credit",
  },
  "mcp:read": {
    group: "MCP",
    label: "MCP read tools",
    description: "Agent tools that read the project",
  },
  "mcp:write": {
    group: "MCP",
    label: "MCP write tools",
    description: "Agent tools that change the project",
  },
  "content:read": {
    group: "MCP",
    label: "Read captured content",
    description: "Asks, answers and tool payloads over MCP, once content reading is on",
  },
};

export const INGEST_SCOPES: readonly ApiKeyScope[] = [
  "ingest:traces",
  "ingest:logs",
  "ingest:events",
];

/**
 * Read-only reaches every read surface except captured content, which needs its
 * own scope: text end users typed is the one thing a read key should not get by
 * default. It also leaves out embeddings and Tool Picker, since each call spends
 * credit, which is a change.
 */
export const READ_ONLY_SCOPES: readonly ApiKeyScope[] = [
  "catalog:read",
  "skills:read",
  "runtime_catalog:read",
  "jobs:read",
  "intent_graph:read",
  "mcp:read",
];

export const API_KEY_PRESETS = ["full", "read_only", "ingest"] as const;
export type ApiKeyPreset = (typeof API_KEY_PRESETS)[number];

/** What a key's access reads as in the dashboard. `custom` is any other list. */
export type ApiKeyAccess = ApiKeyPreset | "custom";

export const API_KEY_PRESET_INFO: Readonly<
  Record<ApiKeyPreset, { label: string; description: string }>
> = {
  full: {
    label: "Full access",
    description: "Everything a key can do. Keep it secret: server side only.",
  },
  read_only: {
    label: "Read-only",
    description:
      "Reads the catalog, skills, jobs and the intent graph. Changes nothing. Keep it secret.",
  },
  ingest: {
    label: "Ingest only",
    description: "Sends traces, logs and events, and reads nothing. Safe to ship inside an app.",
  },
};

export function presetScopes(preset: ApiKeyPreset): readonly StoredApiKeyScope[] {
  switch (preset) {
    case "full":
      return [ALL_SCOPES];
    case "read_only":
      return READ_ONLY_SCOPES;
    case "ingest":
      return INGEST_SCOPES;
  }
}

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === "string" && (API_KEY_SCOPES as readonly string[]).includes(value);
}

/** Whether a stored scope list grants one scope. Unknown stored values grant nothing. */
export function hasScope(scopes: readonly string[], scope: ApiKeyScope): boolean {
  return scopes.includes(ALL_SCOPES) || scopes.includes(scope);
}

/**
 * A key is publishable (safe to put in a client app) when every scope it holds
 * only adds data to its own project. An empty list is not publishable: it is a
 * mistake, not a public key.
 */
export function isPublishableScopes(scopes: readonly string[]): boolean {
  return (
    scopes.length > 0 &&
    scopes.every((scope) => (INGEST_SCOPES as readonly string[]).includes(scope))
  );
}

/** Which preset a stored list matches, or `custom`. Order does not matter. */
export function apiKeyAccess(scopes: readonly string[]): ApiKeyAccess {
  if (scopes.includes(ALL_SCOPES)) return "full";
  for (const preset of ["read_only", "ingest"] as const) {
    if (sameSet(scopes, presetScopes(preset))) return preset;
  }
  return "custom";
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export type ResolvedScopeChoice =
  | { ok: true; scopes: StoredApiKeyScope[] }
  | { ok: false; error: string };

/**
 * Turn what the create form sent into the list to store. A preset wins; a
 * custom list must be non-empty and name only known scopes, and is stored in
 * canonical order without duplicates. Anything else is refused rather than
 * falling back to Full, so a mangled request never issues a broader key.
 */
export function resolveScopeChoice(input: {
  preset?: ApiKeyPreset | "custom" | null;
  scopes?: readonly unknown[] | null;
}): ResolvedScopeChoice {
  const preset = input.preset ?? "full";
  if (preset !== "custom") {
    if (!(API_KEY_PRESETS as readonly string[]).includes(preset)) {
      return { ok: false, error: "Choose one of the offered access levels." };
    }
    return { ok: true, scopes: [...presetScopes(preset)] };
  }
  const chosen = input.scopes ?? [];
  if (chosen.length === 0) return { ok: false, error: "Pick at least one permission." };
  if (!chosen.every(isApiKeyScope))
    return { ok: false, error: "One of the chosen permissions is not recognized." };
  return { ok: true, scopes: API_KEY_SCOPES.filter((scope) => chosen.includes(scope)) };
}

/**
 * The plain reason a 403 carries. Names the scope and the fix, so whoever reads
 * the response (a developer, an SDK log) knows it is the key's access and not
 * the key itself.
 */
export function missingScopeMessage(scope: ApiKeyScope): string {
  return `This API key does not have the "${scope}" permission (${API_KEY_SCOPE_INFO[scope].label.toLowerCase()}). Use a key that has it, or create one in project Settings > API keys.`;
}
