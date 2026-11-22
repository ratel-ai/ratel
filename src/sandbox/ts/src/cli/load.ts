import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withSdkParams } from "../auto-params.js";
import { captureSetup } from "../catalog.js";
import { isSandbox, type Sandbox } from "../sandbox.js";

// Loads user sandbox files. Only the child worker calls this: the CLI parent never
// imports user code.

export interface LoadedSandbox {
  readonly sandbox: Sandbox;
  readonly file: string;
}

/**
 * Imports each file and collects its exported sandboxes, with the params that loading
 * the file reached through the SDK (tools registered on a `ratel()` core, prompts and
 * models read through the catalog). Throws on a load error or a duplicate id.
 */
export async function loadSandboxes(
  root: string,
  files: readonly string[],
): Promise<LoadedSandbox[]> {
  const sandboxes: LoadedSandbox[] = [];
  for (const file of files) {
    let loaded: Awaited<ReturnType<typeof captureSetup<Record<string, unknown>>>>;
    try {
      const href = pathToFileURL(join(root, file)).href;
      loaded = await captureSetup(() => import(href) as Promise<Record<string, unknown>>);
    } catch (err) {
      throw new Error(`cannot load ${file}: ${messageOf(err)}`);
    }
    for (const exported of new Set(Object.values(loaded.result))) {
      if (!isSandbox(exported)) continue;
      const value = withSdkParams(exported, loaded.capture);
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
