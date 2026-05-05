import { dirname, join } from "node:path";

export type RatelScope = "user" | "project" | "local";

export interface HierarchyEnv {
  homeDir: string;
  projectRoot?: string;
}

export class ProjectRootNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRootNotFoundError";
  }
}

/**
 * Resolve a `--scope` flag into a {@link RatelScope}. Accepts user|project|local;
 * falls back to `"user"` when the flag is absent. Throws on unrecognized values
 * (with a special hint for the legacy `"global"` alias).
 */
export function resolveScope(flag: unknown): RatelScope {
  if (flag === undefined || flag === false) return "user";
  if (typeof flag !== "string" || flag.length === 0) return "user";
  if (flag === "global") {
    throw new Error('--scope value "global" is no longer supported; use "user" instead');
  }
  if (flag !== "user" && flag !== "project" && flag !== "local") {
    throw new Error(`--scope must be one of user|project|local, got "${flag}"`);
  }
  return flag;
}

export function ratelConfigPath(scope: RatelScope, env: HierarchyEnv): string {
  if (scope === "user") {
    return join(env.homeDir, ".ratel", "config.json");
  }
  if (!env.projectRoot) {
    throw new ProjectRootNotFoundError(`scope "${scope}" requires a project root`);
  }
  if (scope === "project") {
    return join(env.projectRoot, ".ratel", "config.json");
  }
  return join(env.projectRoot, ".ratel", "config.local.json");
}

export interface ExistsFs {
  existsSync(path: string): boolean;
}

const WORKSPACE_MARKERS = ["pnpm-workspace.yaml"] as const;
const FALLBACK_MARKERS = [".git", ".mcp.json", "package.json"] as const;

export function findProjectRoot(startDir: string, fs: ExistsFs): string {
  for (const dir of walkUp(startDir)) {
    if (WORKSPACE_MARKERS.some((m) => fs.existsSync(join(dir, m)))) {
      return dir;
    }
  }
  for (const dir of walkUp(startDir)) {
    if (FALLBACK_MARKERS.some((m) => fs.existsSync(join(dir, m)))) {
      return dir;
    }
  }
  throw new ProjectRootNotFoundError(`no project marker found above ${startDir}`);
}

function* walkUp(dir: string): Generator<string> {
  let cur = dir;
  while (true) {
    yield cur;
    const parent = dirname(cur);
    if (parent === cur) return;
    cur = parent;
  }
}
