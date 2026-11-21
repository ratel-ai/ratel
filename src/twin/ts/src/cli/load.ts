import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isTwin, type Twin } from "../twin.js";

// Loads user twin files. Only the child worker calls this: the CLI parent never
// imports user code.

export interface LoadedTwin {
  readonly twin: Twin;
  readonly file: string;
}

/** Imports each file and collects its exported twins. Throws on a load error or a duplicate id. */
export async function loadTwins(root: string, files: readonly string[]): Promise<LoadedTwin[]> {
  const twins: LoadedTwin[] = [];
  for (const file of files) {
    let mod: Record<string, unknown>;
    try {
      mod = await import(pathToFileURL(join(root, file)).href);
    } catch (err) {
      throw new Error(`cannot load ${file}: ${messageOf(err)}`);
    }
    for (const value of new Set(Object.values(mod))) {
      if (!isTwin(value)) continue;
      const clash = twins.find(({ twin }) => twin.id === value.id);
      if (clash)
        throw new Error(`twin id "${value.id}" is declared in both ${clash.file} and ${file}`);
      twins.push({ twin: value, file });
    }
  }
  return twins;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
