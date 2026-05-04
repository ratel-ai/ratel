import { type BackupFs, type BackupManifest, startBackup } from "./backup.js";
import type { HierarchyEnv } from "./hierarchy.js";
import type { FileChange } from "./import-plan.js";
import type { JsonFs } from "./io.js";

export interface ExecuteOptions {
  fs: JsonFs & BackupFs;
  env: HierarchyEnv;
  action: BackupManifest["action"];
  now?: () => Date;
}

export async function executePlan(
  changes: readonly FileChange[],
  opts: ExecuteOptions,
): Promise<BackupManifest> {
  const now = opts.now ?? (() => new Date());

  if (changes.length === 0) {
    return { createdAt: now().toISOString(), action: opts.action, entries: [] };
  }

  const seen = new Set<string>();
  for (const c of changes) {
    if (c.kind !== "write") continue;
    if (seen.has(c.path)) {
      throw new Error(`plan would write ${c.path} twice`);
    }
    seen.add(c.path);
  }

  const session = startBackup(opts.env, opts.fs, now);
  for (const c of changes) {
    if (c.kind === "write") {
      await session.capture(c.path);
    }
  }
  const manifest = await session.finalize(opts.action);

  const written: string[] = [];
  try {
    for (const c of changes) {
      if (c.kind === "write") {
        await opts.fs.writeAtomic(c.path, c.after);
        written.push(c.path);
      }
    }
  } catch (err) {
    for (const path of written) {
      const entry = manifest.entries.find((e) => e.originalPath === path);
      if (!entry) continue;
      if (entry.existedBefore) {
        const text = await opts.fs.read(entry.backupPath);
        if (text !== null) await opts.fs.writeAtomic(path, text);
      } else {
        await opts.fs.remove(path);
      }
    }
    throw err;
  }

  return manifest;
}
