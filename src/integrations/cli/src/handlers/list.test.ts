import { describe, expect, it } from "vitest";
import type { BackupFs } from "../backup.js";
import { startBackup } from "../backup.js";
import type { ClaudeFs } from "../claude.js";
import type { JsonFs } from "../io.js";
import { silentPromptAdapter } from "../prompts.js";
import { runListBackups } from "./list.js";
import type { HandlerCtx } from "./types.js";

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

function ctx(fs: MemFs): HandlerCtx {
  const lines: string[] = [];
  const c: HandlerCtx = {
    argv: { group: "backup", verb: "list", configPaths: [], rest: [], extras: [], flags: {} },
    env: { homeDir: HOME },
    fs,
    log: (m) => lines.push(m),
    prompts: silentPromptAdapter(),
  };
  (c as HandlerCtx & { _lines: string[] })._lines = lines;
  return c;
}

function logsOf(c: HandlerCtx): string[] {
  return (c as HandlerCtx & { _lines: string[] })._lines;
}

describe("runListBackups", () => {
  it("logs a 'no backups' line when none exist", async () => {
    const fs = new MemFs();
    const c = ctx(fs);
    await runListBackups(c);
    expect(logsOf(c).join("\n")).toMatch(/no backups/i);
  });

  it("lists existing backups newest-first with timestamp, action, and file count", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "A");
    fs.files.set("/b.json", "B");
    const s1 = startBackup({ homeDir: HOME }, fs, () => new Date("2026-05-01T10:00:00Z"));
    await s1.capture("/a.json");
    await s1.finalize("import");
    const s2 = startBackup({ homeDir: HOME }, fs, () => new Date("2026-05-02T10:00:00Z"));
    await s2.capture("/b.json");
    await s2.finalize("add");

    const c = ctx(fs);
    await runListBackups(c);
    const out = logsOf(c).join("\n");
    const addPos = out.indexOf("add");
    const importPos = out.indexOf("import");
    expect(addPos).toBeGreaterThanOrEqual(0);
    expect(importPos).toBeGreaterThanOrEqual(0);
    expect(addPos).toBeLessThan(importPos); // newest first
    expect(out).toMatch(/2026-05-02/);
    expect(out).toMatch(/2026-05-01/);
    expect(out).toMatch(/1 file/i);
  });
});
