import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { pathToFileURL } from "node:url";

// Finds and imports a package the way the user's own code would: from the
// project of one file, never from where @ratel-ai/twin is installed. Then the
// AI SDK model a twin resolves and the user's `streamText` come from the same
// `ai` instance.

/** The packages of the project that holds `from` (a file or a folder). */
export interface ProjectPackages {
  /** The folder the lookup starts from. */
  readonly root: string;
  /** True when the project has the package. */
  installed(specifier: string): boolean;
  /** Imports the package's ESM entry. Rejects when the project does not have it. */
  load(specifier: string): Promise<Record<string, unknown>>;
}

export function projectPackages(from: string): ProjectPackages {
  const root = isDirectory(from) ? from : dirname(from);
  return {
    root,
    installed: (specifier) => packageDir(specifier, root) !== undefined,
    async load(specifier) {
      const dir = packageDir(specifier, root);
      if (!dir) throw new Error(`${specifier} is not installed in ${root}`);
      return (await import(pathToFileURL(join(dir, esmEntry(dir))).href)) as Record<
        string,
        unknown
      >;
    },
  };
}

/** The real folder of `specifier`, looked up in each node_modules from `start` to the root. */
export function packageDir(specifier: string, start: string): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = join(dir, "node_modules", specifier, "package.json");
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    if (dir === parse(dir).root) return undefined;
    dir = dirname(dir);
  }
}

/** The file an `import` of the package loads: its exports' import condition, else module or main. */
export function esmEntry(dir: string): string {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    exports?: unknown;
    module?: string;
    main?: string;
  };
  const exported = pkg.exports;
  const dot =
    typeof exported === "object" && exported !== null && !Array.isArray(exported) && "." in exported
      ? (exported as Record<string, unknown>)["."]
      : exported;
  return pickTarget(dot) ?? pkg.module ?? pkg.main ?? "index.js";
}

const CONDITIONS = ["import", "module", "node", "default"];

function pickTarget(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const t of target) {
      const found = pickTarget(t);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof target !== "object" || target === null) return undefined;
  for (const condition of CONDITIONS) {
    if (!(condition in target)) continue;
    const found = pickTarget((target as Record<string, unknown>)[condition]);
    if (found) return found;
  }
  return undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
