import { join, resolve } from "node:path";

export interface LocateBinEnv {
  envVar?: string;
  whichResult?: string;
  workspaceRoot?: string;
  exists?: (path: string) => Promise<boolean>;
  promptForPath?: () => Promise<string>;
}

export interface ResolvedBin {
  command: string;
  args: string[];
  source: "env" | "path" | "workspace" | "prompt";
}

const WORKSPACE_BIN_REL = join("src", "cli", "dist", "bin.js");

export async function locateRatelBin(env: LocateBinEnv): Promise<ResolvedBin> {
  if (env.envVar && env.envVar.length > 0) {
    return { command: env.envVar, args: [], source: "env" };
  }
  if (env.whichResult && env.whichResult.length > 0) {
    return { command: env.whichResult, args: [], source: "path" };
  }
  if (env.workspaceRoot) {
    const path = join(env.workspaceRoot, WORKSPACE_BIN_REL);
    const ok = env.exists ? await env.exists(path) : true;
    if (ok) {
      return { command: "node", args: [path], source: "workspace" };
    }
  }
  if (env.promptForPath) {
    const v = (await env.promptForPath()).trim();
    if (v) {
      return { command: resolve(v), args: [], source: "prompt" };
    }
  }
  throw new Error(
    "Could not locate the ratel binary. Set $RATEL_BIN or run from inside the ratel workspace.",
  );
}
