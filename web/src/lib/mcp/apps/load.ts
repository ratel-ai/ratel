import { readFileSync } from "node:fs";
import { VIEWS_PATH } from "@ratel/mcp-apps";
import { buildMcpAppCatalog, type McpAppCatalog } from "@/lib/mcp/apps/catalog";
import type { McpAppView } from "@/lib/mcp/apps/types";
import { assembleOperations } from "@/lib/mcp/operations";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";

const logger = getLogger("mcp/apps");

/**
 * Where the view build (the @ratel/mcp-apps package) writes its output. Gitignored:
 * `pnpm build`, `dev`, `typecheck` and `test` run the view build first.
 */
export const GENERATED_VIEWS_PATH = VIEWS_PATH;

export interface McpAppLoadDeps {
  /** The built views, or null when the view build has not run. */
  readViews: () => readonly McpAppView[] | null;
  /** Every tool name the server registers, whatever the caller may reach. */
  toolIds: () => ReadonlySet<string>;
}

/**
 * The built views file: null when it is not there, and a throw when it is not
 * a JSON array (a broken build). loadMcpAppCatalog lets the throw through and
 * the route handler (appsFor) serves the server without views.
 */
export function readGeneratedViews(
  file: string = GENERATED_VIEWS_PATH,
): readonly McpAppView[] | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed))
    throw new Error(`${GENERATED_VIEWS_PATH} must hold an array of views`);
  return parsed as McpAppView[];
}

export const defaultMcpAppLoadDeps: McpAppLoadDeps = {
  readViews: readGeneratedViews,
  // The full set, writes included: a binding is checked against every tool the
  // server can register, not against what one caller happens to reach.
  toolIds: () =>
    new Set([
      "whoami",
      ...assembleOperations({ focusedConsole: true }).map((operation) => operation.id),
    ]),
};

/**
 * Read the built views once per process and check every binding against the
 * registry. Throws on a bad binding (`McpAppCatalogError`); an absent build is
 * an empty catalog, logged, so a checkout that never built views still serves
 * every tool.
 */
export function loadMcpAppCatalog(deps: McpAppLoadDeps = defaultMcpAppLoadDeps): McpAppCatalog {
  const views = deps.readViews();
  if (views === null) {
    logger.warn({ path: GENERATED_VIEWS_PATH }, "mcp app views not built");
    return buildMcpAppCatalog([], new Set());
  }
  const catalog = buildMcpAppCatalog(views, deps.toolIds());
  logger.info(
    {
      views: views.map((view) => view.view),
      bound_tools: views.reduce((n, view) => n + view.bindings.length, 0),
    },
    "mcp app views loaded",
  );
  return catalog;
}

/**
 * A loader memoized for the process, failure included: views.json is built
 * with the image and cannot change under a running process, so a bad one is
 * read, logged and reported once, and every later request gets no views
 * (`appsFor` serves main's server) without reading the file again.
 */
export function memoizedCatalog(
  load: () => McpAppCatalog,
  report: (error: unknown) => void,
): () => McpAppCatalog {
  let cached: McpAppCatalog | null = null;
  return () => {
    if (cached) return cached;
    try {
      cached = load();
    } catch (error) {
      logger.error(
        { err: error, path: GENERATED_VIEWS_PATH },
        "mcp app views failed to load; serving none until the next deploy",
      );
      report(error);
      cached = buildMcpAppCatalog([], new Set());
    }
    return cached;
  };
}

/** {@link loadMcpAppCatalog}, memoized for the process (a failure as no views, reported once). */
export const mcpAppCatalog: () => McpAppCatalog = memoizedCatalog(
  () => loadMcpAppCatalog(),
  (error) => reportServerException(error, "system:mcp-apps", { component: "mcp_apps" }),
);
