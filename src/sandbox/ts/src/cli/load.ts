import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isSandbox, type Sandbox } from "../sandbox.js";

// Loads user sandbox files. Only the child worker calls this: the CLI parent never
// imports user code.

export interface LoadedSandbox {
  readonly sandbox: Sandbox;
  readonly file: string;
}

/** Imports each file and collects its exported sandboxes. Throws on a load error or a duplicate id. */
export async function loadSandboxes(
  root: string,
  files: readonly string[],
): Promise<LoadedSandbox[]> {
  const sandboxes: LoadedSandbox[] = [];
  for (const file of files) {
    let mod: Record<string, unknown>;
    try {
      mod = await import(pathToFileURL(join(root, file)).href);
    } catch (err) {
      throw new Error(`cannot load ${file}: ${messageOf(err)}`);
    }
    for (const value of new Set(Object.values(mod))) {
      if (!isSandbox(value)) continue;
      const clash = sandboxes.find(({ sandbox }) => sandbox.id === value.id);
      if (clash)
        throw new Error(`sandbox id "${value.id}" is declared in both ${clash.file} and ${file}`);
      sandboxes.push({ sandbox: value, file });
    }
  }
  return sandboxes;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
