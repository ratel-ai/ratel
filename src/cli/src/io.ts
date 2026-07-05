import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { BackupFs } from "./backup.js";
import type { ClaudeFs } from "./claude.js";
import * as fsAdapter from "./io-fs.js";

export interface JsonFs {
  read(path: string): Promise<string | null>;
  writeAtomic(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export const nodeJsonFs: JsonFs = {
  async read(path) {
    try {
      return await fsAdapter.readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  async writeAtomic(path, contents) {
    await fsAdapter.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.ratel-tmp-${randomUUID()}`;
    await fsAdapter.writeFile(tmp, contents);
    try {
      await fsAdapter.rename(tmp, path);
    } catch (err) {
      await fsAdapter.rm(tmp, { force: true });
      throw err;
    }
  },
  async exists(path) {
    try {
      await fsAdapter.access(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  },
};

export const nodeFs: JsonFs & BackupFs & ClaudeFs = {
  ...nodeJsonFs,
  async write(path, contents) {
    await fsAdapter.mkdir(dirname(path), { recursive: true });
    await fsAdapter.writeFile(path, contents);
  },
  async remove(path) {
    await fsAdapter.rm(path, { force: true });
  },
  async mkdirp(path) {
    await fsAdapter.mkdir(path, { recursive: true });
  },
  async list(path) {
    try {
      return await fsAdapter.readdir(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  },
};

export async function readJson<T = unknown>(fs: JsonFs, path: string): Promise<T | null> {
  const text = await fs.read(path);
  if (text === null) return null;
  return JSON.parse(text) as T;
}

export async function writeJson(fs: JsonFs, path: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeAtomic(path, text);
}
