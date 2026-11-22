import { LINEAGE_STAGES, type LineageStage } from "./types";

/**
 * The four stages as places in the console (RC-45): which stage each project
 * page belongs to (routes never moved, so this is a map, not a tree). Pure and
 * client-safe.
 */

/**
 * Every project page by stage, as path prefixes under `/project/<id>`. The
 * most specific prefix wins (`/improvement/tool-explorer/suggestions` is a
 * Fix, `/improvement/tool-explorer` is a Task). Pages outside the spine
 * (Catalog, the APIs, Settings) are setup and have no stage.
 */
export const STAGE_ROUTES: Readonly<Record<LineageStage, readonly string[]>> = {
  monitor: ["", "/dashboards", "/traces", "/runtime-events"],
  insights: [
    "/health",
    "/insights",
    "/intents",
    "/improvement/health",
    "/improvement/intents",
    "/improvement/tool-explorer",
  ],
  improve: [
    "/improvement",
    "/improvement/fixes",
    "/improvement/tool-explorer/suggestions",
    "/improvement/match-quality",
    "/improvement/adaptive-ranking",
    "/quality",
    "/calibration",
  ],
  ship: ["/ship"],
};

/** Project pages that are setup, not a stage. */
export const SETUP_ROUTES: readonly string[] = [
  "/catalogs",
  "/playground",
  "/models",
  "/settings",
  "/chat",
];

const PROJECT_PATH = /^\/project\/[^/]+(\/.*)?$/;

/** The stage of a project page, or null outside a project or on a setup page. */
export function stageOfPath(pathname: string): LineageStage | null {
  const match = PROJECT_PATH.exec(pathname.split(/[?#]/)[0] ?? "");
  if (!match) return null;
  const rest = (match[1] ?? "").replace(/\/$/, "");
  let best: { stage: LineageStage | null; length: number } | null = null;
  const consider = (stage: LineageStage | null, prefix: string) => {
    const hit = prefix === "" ? rest === "" : rest === prefix || rest.startsWith(`${prefix}/`);
    if (hit && (!best || prefix.length > best.length)) best = { stage, length: prefix.length };
  };
  for (const stage of LINEAGE_STAGES)
    for (const prefix of STAGE_ROUTES[stage]) consider(stage, prefix);
  for (const prefix of SETUP_ROUTES) consider(null, prefix);
  return (best as { stage: LineageStage | null } | null)?.stage ?? null;
}
