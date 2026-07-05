import { join, resolve } from "node:path";
import type { ServerEntry } from "@ratel-ai/mcp-server";
import { type HierarchyEnv, ProjectRootNotFoundError } from "./hierarchy.js";

export type ClaudeScope = "user" | "project" | "local";

export interface ClaudeFs {
  read(path: string): Promise<string | null>;
}

export interface ClaudeConfigDoc {
  scope: ClaudeScope;
  path: string;
  raw: Record<string, unknown>;
  mcpServers: Record<string, ServerEntry>;
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
  if (scope === "local" && !env.projectRoot) {
    throw new ProjectRootNotFoundError(`scope "local" requires a project root`);
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
  const mcpServers = readMcpServers(scope, raw, env);
  return { scope, path, raw, mcpServers };
}

function readMcpServers(
  scope: ClaudeScope,
  raw: Record<string, unknown>,
  env: HierarchyEnv,
): Record<string, ServerEntry> {
  if (scope === "local") {
    const projects = raw.projects;
    if (!isPlainObject(projects)) return {};
    const root = resolve(env.projectRoot as string);
    const entry = projects[root];
    if (!isPlainObject(entry)) return {};
    return asServerEntries(entry.mcpServers);
  }
  return asServerEntries(raw.mcpServers);
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
