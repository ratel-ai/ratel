import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  type OAuthClientInformationFull,
  type OAuthTokens,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import lockfile from "proper-lockfile";

export type ClearScope = "all" | "tokens" | "client" | "verifier" | "discovery";

export interface OAuthStoreState {
  tokens?: OAuthTokens;
  expires_at?: number;
  client_information?: OAuthClientInformationFull;
  code_verifier?: string;
  state?: string;
  discovery_state?: OAuthDiscoveryState;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const LOCK_OPTS = {
  realpath: false,
  retries: { retries: 200, factor: 1, minTimeout: 25, maxTimeout: 200 },
  stale: 10_000,
} as const;

// Per-path AsyncLocalStorage so that nested withLock / save calls inside a held
// transaction don't re-acquire the file lock (which would deadlock).
const HELD_LOCKS_BY_PATH = new Map<string, AsyncLocalStorage<true>>();
function alsFor(path: string): AsyncLocalStorage<true> {
  let als = HELD_LOCKS_BY_PATH.get(path);
  if (!als) {
    als = new AsyncLocalStorage<true>();
    HELD_LOCKS_BY_PATH.set(path, als);
  }
  return als;
}

export class RatelOAuthStore {
  constructor(private readonly filePath: string) {}

  /**
   * Run `fn` while holding an exclusive cross-process lock on the store file.
   * Reentrant: a nested withLock or save() call from inside `fn` reuses the
   * outer lock instead of deadlocking.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const als = alsFor(this.filePath);
    if (als.getStore()) return fn();
    await mkdir(dirname(this.filePath), { recursive: true, mode: DIR_MODE });
    await chmod(dirname(this.filePath), DIR_MODE).catch(() => undefined);
    const release = await lockfile.lock(this.filePath, LOCK_OPTS);
    try {
      return await als.run(true, () => fn());
    } finally {
      await release().catch(() => undefined);
    }
  }

  async load(): Promise<OAuthStoreState> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state: OAuthStoreState = {};
    if (parsed.tokens !== undefined) {
      state.tokens = OAuthTokensSchema.parse(parsed.tokens);
    }
    if (typeof parsed.expires_at === "number") {
      state.expires_at = parsed.expires_at;
    }
    if (parsed.client_information !== undefined) {
      state.client_information = parsed.client_information as OAuthClientInformationFull;
    }
    if (typeof parsed.code_verifier === "string") {
      state.code_verifier = parsed.code_verifier;
    }
    if (typeof parsed.state === "string") {
      state.state = parsed.state;
    }
    if (parsed.discovery_state !== undefined) {
      state.discovery_state = parsed.discovery_state as OAuthDiscoveryState;
    }
    return state;
  }

  async save(partial: OAuthStoreState): Promise<void> {
    await this.withLock(async () => {
      const current = await this.load();
      const next: OAuthStoreState = { ...current, ...partial };
      if (partial.tokens !== undefined) {
        const validated = OAuthTokensSchema.parse(partial.tokens);
        next.tokens = validated;
        next.expires_at =
          typeof validated.expires_in === "number"
            ? Date.now() + validated.expires_in * 1000
            : undefined;
      }
      await this.writeAtomic(next);
    });
  }

  async clear(scope: ClearScope): Promise<void> {
    if (scope === "all") {
      await this.withLock(async () => {
        try {
          await rm(this.filePath, { force: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      });
      return;
    }
    await this.withLock(async () => {
      const current = await this.load();
      const next: OAuthStoreState = { ...current };
      switch (scope) {
        case "tokens":
          delete next.tokens;
          delete next.expires_at;
          break;
        case "client":
          delete next.client_information;
          break;
        case "verifier":
          delete next.code_verifier;
          delete next.state;
          break;
        case "discovery":
          delete next.discovery_state;
          break;
      }
      await this.writeAtomic(next);
    });
  }

  private async writeAtomic(state: OAuthStoreState): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE).catch(() => {
      // best-effort: dir may have stricter ownership; existing mode wins
    });
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const tmp = `${this.filePath}.ratel-tmp-${randomUUID()}`;
    await writeFile(tmp, payload, { mode: FILE_MODE });
    try {
      await rename(tmp, this.filePath);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    await chmod(this.filePath, FILE_MODE).catch(() => {
      // best-effort
    });
  }
}
