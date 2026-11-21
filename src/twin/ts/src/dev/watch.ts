import { type FSWatcher, watch } from "node:fs";
import { IGNORED_DIRS } from "../cli/discover.js";

export const RELOAD_DEBOUNCE_MS = 150;

/**
 * Calls onChange once per burst of file changes under root. Skips dependency
 * and build directories and dot-directories, so a build in watch mode does not
 * reload the runner in a loop. `.env` at any depth still counts.
 */
export function watchProject(root: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const watcher: FSWatcher = watch(root, { recursive: true }, (_event, file) => {
    if (file !== null && !relevant(String(file))) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, RELOAD_DEBOUNCE_MS);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

function relevant(file: string): boolean {
  const parts = file.split(/[\\/]/);
  const dirs = parts.slice(0, -1);
  return !dirs.some((dir) => IGNORED_DIRS.has(dir) || dir.startsWith("."));
}
