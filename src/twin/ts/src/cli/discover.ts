import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Directories discovery never enters: dependencies and build output. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
]);
const TWIN_FILE = /\.twin\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;

/** Every `**\/*.twin.*` file under root, as sorted POSIX paths relative to root. */
export function discoverTwinFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile() && TWIN_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        found.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}
