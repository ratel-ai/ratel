import { join, resolve } from "node:path";
import type { ServerEntry } from "@ratel-ai/mcp-server";
import { type HierarchyEnv, ProjectRootNotFoundError, walkUp } from "./hierarchy.js";

export type ClaudeScope = "user" | "project" | "local";

export interface ClaudeFs {
  read(path: string): Promise<string | null>;
}

export interface ClaudeConfigDoc {
  scope: ClaudeScope;
  path: string;
  raw: Record<string, unknown>;
  mcpServers: Record<string, ServerEntry>;
  /**
   * For `local` scope only: maps each entry name back to the `projects[<dir>]`
   * key it was discovered under. Populated even when empty (so callers can
   * distinguish "no local lookup happened" from "lookup happened, found nothing").
   */
  localOriginByName?: Record<string, string>;
}

export function claudeConfigPath(scope: ClaudeScope, env: HierarchyEnv): string {
  if (scope === "user" || scope === "local") {
    return join(env.homeDir, ".claude.json");
  }
  if (!env.projectRoot) {
    throw new ProjectRootNotFoundError(`scope "project" requires a project root`);
  }
  return join(env.projectRoot, ".mcp.json");
}

export async function readClaudeConfig(
  scope: ClaudeScope,
  env: HierarchyEnv,
  fs: ClaudeFs,
): Promise<ClaudeConfigDoc | null> {
  if (scope === "local" && !env.cwd && !env.projectRoot) {
    throw new ProjectRootNotFoundError(`scope "local" requires cwd or projectRoot`);
  }
  const path = claudeConfigPath(scope, env);
  const text = await fs.read(path);
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
  if (!isPlainObject(raw)) {
    throw new Error(`${path}: root must be a JSON object`);
  }
  if (scope === "local") {
    const { entries, originByName } = readLocalMcpServers(raw, env);
    return { scope, path, raw, mcpServers: entries, localOriginByName: originByName };
  }
  return { scope, path, raw, mcpServers: asServerEntries(raw.mcpServers) };
}

/**
 * Walks parents from `env.cwd` (or `env.projectRoot` as a fallback) and
 * collects entries from every `projects[<ancestor>].mcpServers` key found in
 * `~/.claude.json`. Nearest-ancestor wins on name collisions, mirroring how
 * Claude Code itself resolves descendant sessions to ancestor `projects[]`
 * entries.
 */
function readLocalMcpServers(
  raw: Record<string, unknown>,
  env: HierarchyEnv,
): { entries: Record<string, ServerEntry>; originByName: Record<string, string> } {
  const entries: Record<string, ServerEntry> = {};
  const originByName: Record<string, string> = {};
  const projects = raw.projects;
  if (!isPlainObject(projects)) return { entries, originByName };
  const start = resolve((env.cwd ?? env.projectRoot) as string);
  for (const dir of walkUp(start)) {
    const projEntry = projects[dir];
    if (!isPlainObject(projEntry)) continue;
    for (const [name, entry] of Object.entries(asServerEntries(projEntry.mcpServers))) {
      if (name in entries) continue;
      entries[name] = entry;
      originByName[name] = dir;
    }
  }
  return { entries, originByName };
}

function asServerEntries(v: unknown): Record<string, ServerEntry> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, ServerEntry> = {};
  for (const [k, ent] of Object.entries(v)) {
    if (isPlainObject(ent)) out[k] = ent as unknown as ServerEntry;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
