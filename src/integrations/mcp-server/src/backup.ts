import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { HierarchyEnv } from "./hierarchy.js";

export interface BackupFs {
  read(path: string): Promise<string | null>;
  write(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  list(path: string): Promise<string[]>;
}

export interface BackupEntry {
  originalPath: string;
  backupPath: string;
  existedBefore: boolean;
}

export interface BackupManifest {
  createdAt: string;
  action: "import" | "add" | "remove" | "edit" | "link";
  entries: BackupEntry[];
}

export interface BackupSession {
  dir: string;
  capture(originalPath: string): Promise<void>;
  finalize(action: BackupManifest["action"]): Promise<BackupManifest>;
}

const MANIFEST = "manifest.json";

function backupsRoot(env: HierarchyEnv): string {
  return join(env.homeDir, ".ratel", "backups");
}

function safeStamp(d: Date): string {
  return d.toISOString().replace(/:/g, "-");
}

function backupFileName(originalPath: string): string {
  const hash = createHash("sha1").update(originalPath).digest("hex").slice(0, 12);
  return `${hash}-${basename(originalPath)}`;
}

export function startBackup(
  env: HierarchyEnv,
  fs: BackupFs,
  now: () => Date = () => new Date(),
): BackupSession {
  const dir = join(backupsRoot(env), safeStamp(now()));
  const captured = new Map<string, BackupEntry>();
  let dirCreated = false;

  async function ensureDir() {
    if (dirCreated) return;
    await fs.mkdirp(dir);
    dirCreated = true;
  }

  return {
    dir,
    async capture(originalPath: string) {
      if (captured.has(originalPath)) return;
      await ensureDir();
      const backupPath = join(dir, backupFileName(originalPath));
      const before = await fs.read(originalPath);
      const existedBefore = before !== null;
      if (existedBefore) {
        await fs.write(backupPath, before as string);
      }
      captured.set(originalPath, { originalPath, backupPath, existedBefore });
    },
    async finalize(action) {
      await ensureDir();
      const manifest: BackupManifest = {
        createdAt: now().toISOString(),
        action,
        entries: Array.from(captured.values()),
      };
      await fs.write(join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
      return manifest;
    },
  };
}

export async function listBackups(env: HierarchyEnv, fs: BackupFs): Promise<BackupManifest[]> {
  const root = backupsRoot(env);
  const subdirs = await fs.list(root).catch(() => []);
  const manifests: { name: string; manifest: BackupManifest }[] = [];
  for (const name of subdirs) {
    const text = await fs.read(join(root, name, MANIFEST));
    if (text === null) continue;
    try {
      manifests.push({ name, manifest: JSON.parse(text) as BackupManifest });
    } catch {
      // ignore unreadable manifest
    }
  }
  manifests.sort((a, b) => (a.name < b.name ? 1 : -1));
  return manifests.map((m) => m.manifest);
}

export async function restoreLatest(
  env: HierarchyEnv,
  fs: BackupFs,
): Promise<BackupManifest | null> {
  const all = await listBackups(env, fs);
  if (all.length === 0) return null;
  const latest = all[0];
  for (const e of latest.entries) {
    if (e.existedBefore) {
      const text = await fs.read(e.backupPath);
      if (text !== null) await fs.write(e.originalPath, text);
    } else {
      await fs.remove(e.originalPath);
    }
  }
  return latest;
}
