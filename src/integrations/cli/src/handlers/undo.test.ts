import { describe, expect, it } from "vitest";
import type { BackupFs } from "../backup.js";
import { startBackup } from "../backup.js";
import type { ClaudeFs } from "../claude.js";
import type { JsonFs } from "../io.js";
import { CANCEL_SYMBOL, type PromptAdapter, silentPromptAdapter } from "../prompts.js";
import type { HandlerCtx } from "./types.js";
import { runUndo } from "./undo.js";

const HOME = "/home/u";

class MemFs implements BackupFs, JsonFs, ClaudeFs {
  files = new Map<string, string>();
  async read(p: string) {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  async write(p: string, c: string) {
    this.files.set(p, c);
  }
  async writeAtomic(p: string, c: string) {
    this.files.set(p, c);
  }
  async remove(p: string) {
    this.files.delete(p);
  }
  async mkdirp() {}
  async exists(p: string) {
    return this.files.has(p);
  }
  async list(p: string) {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    const names = new Set<string>();
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf("/");
        names.add(slash >= 0 ? rest.slice(0, slash) : rest);
      }
    }
    return Array.from(names);
  }
}

function ctxWith(
  fs: MemFs,
  prompts: PromptAdapter = silentPromptAdapter(),
): {
  ctx: HandlerCtx;
  lines: string[];
} {
  const lines: string[] = [];
  return {
    lines,
    ctx: {
      argv: { group: "backup", verb: "undo", configPaths: [], rest: [], extras: [], flags: {} },
      env: { homeDir: HOME },
      fs,
      log: (m) => lines.push(m),
      prompts,
    },
  };
}

describe("runUndo", () => {
  it("logs 'nothing to undo' when no backups exist", async () => {
    const { ctx, lines } = ctxWith(new MemFs());
    await runUndo(ctx);
    expect(lines.join("\n")).toMatch(/nothing to undo/i);
  });

  it("prompts for confirmation before restoring; aborts cleanly when cancelled", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "old");
    const s = startBackup({ homeDir: HOME }, fs, () => new Date("2026-05-03T12:00:00Z"));
    await s.capture("/a.json");
    await s.finalize("import");
    fs.files.set("/a.json", "new");

    const stub: PromptAdapter = {
      ...silentPromptAdapter(),
      async confirm() {
        return false;
      },
    };
    const { ctx } = ctxWith(fs, stub);
    await runUndo(ctx);
    expect(fs.files.get("/a.json")).toBe("new");
  });

  it("treats a cancel-symbol response as abort", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "old");
    const s = startBackup({ homeDir: HOME }, fs, () => new Date("2026-05-03T12:00:00Z"));
    await s.capture("/a.json");
    await s.finalize("import");
    fs.files.set("/a.json", "new");

    const stub: PromptAdapter = {
      ...silentPromptAdapter(),
      async confirm() {
        return CANCEL_SYMBOL;
      },
    };
    const { ctx } = ctxWith(fs, stub);
    await runUndo(ctx);
    expect(fs.files.get("/a.json")).toBe("new");
  });

  it("restores latest backup and logs every restored path on confirm", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "old");
    const s = startBackup({ homeDir: HOME }, fs, () => new Date("2026-05-03T12:00:00Z"));
    await s.capture("/a.json");
    await s.finalize("import");
    fs.files.set("/a.json", "new");

    const { ctx, lines } = ctxWith(fs);
    await runUndo(ctx);
    expect(fs.files.get("/a.json")).toBe("old");
    expect(lines.join("\n")).toMatch(/\/a\.json/);
  });

  it("logs and skips manifest entries whose backup file no longer resolves", async () => {
    const fs = new MemFs();
    const s = startBackup({ homeDir: HOME }, fs, () => new Date("2026-05-03T12:00:00Z"));
    fs.files.set("/missing.json", "x");
    await s.capture("/missing.json");
    const m = await s.finalize("import");
    // Wipe the backup file but leave the manifest intact.
    for (const e of m.entries) fs.files.delete(e.backupPath);

    const { ctx } = ctxWith(fs);
    await runUndo(ctx);
    // No throw — and the file is left in whatever state (we just don't restore).
  });
});
