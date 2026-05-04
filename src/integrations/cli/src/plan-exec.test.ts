import { describe, expect, it } from "vitest";
import type { BackupFs } from "./backup.js";
import type { FileChange } from "./import-plan.js";
import type { JsonFs } from "./io.js";
import { executePlan } from "./plan-exec.js";

const HOME = "/home/u";

class MemFs implements BackupFs, JsonFs {
  files = new Map<string, string>();
  writeAtomicCalls: string[] = [];
  failNextWriteAt: string | null = null;

  async read(p: string) {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  async write(p: string, c: string) {
    this.files.set(p, c);
  }
  async writeAtomic(p: string, c: string) {
    this.writeAtomicCalls.push(p);
    if (this.failNextWriteAt === p) {
      this.failNextWriteAt = null;
      throw new Error(`fail-write-${p}`);
    }
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

const NOW = () => new Date("2026-05-03T12:00:00Z");

describe("executePlan", () => {
  it("captures every original file before any writes happen, even files that don't exist yet", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "OLD");
    const changes: FileChange[] = [
      { kind: "write", path: "/a.json", before: "OLD\n", after: "A\n" },
      { kind: "write", path: "/b.json", before: null, after: "B\n" },
    ];
    const m = await executePlan(changes, {
      fs,
      env: { homeDir: HOME },
      action: "import",
      now: NOW,
    });
    expect(m.entries.find((e) => e.originalPath === "/a.json")?.existedBefore).toBe(true);
    expect(m.entries.find((e) => e.originalPath === "/b.json")?.existedBefore).toBe(false);
    expect(fs.files.get("/a.json")).toBe("A\n");
    expect(fs.files.get("/b.json")).toBe("B\n");
  });

  it("writes a manifest covering every change", async () => {
    const fs = new MemFs();
    const m = await executePlan([{ kind: "write", path: "/a.json", before: null, after: "A" }], {
      fs,
      env: { homeDir: HOME },
      action: "add",
      now: NOW,
    });
    expect(m.action).toBe("add");
    expect(m.entries.map((e) => e.originalPath)).toEqual(["/a.json"]);
  });

  it("rolls back already-written files when a later write fails", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "OLD-A");
    fs.failNextWriteAt = "/b.json";
    await expect(
      executePlan(
        [
          { kind: "write", path: "/a.json", before: "OLD-A", after: "NEW-A" },
          { kind: "write", path: "/b.json", before: null, after: "NEW-B" },
        ],
        { fs, env: { homeDir: HOME }, action: "import", now: NOW },
      ),
    ).rejects.toThrow("fail-write-/b.json");
    expect(fs.files.get("/a.json")).toBe("OLD-A");
    expect(fs.files.has("/b.json")).toBe(false);
  });

  it("returns an empty manifest and writes nothing for a no-op plan", async () => {
    const fs = new MemFs();
    const m = await executePlan([], {
      fs,
      env: { homeDir: HOME },
      action: "import",
      now: NOW,
    });
    expect(m.entries).toEqual([]);
    expect(fs.writeAtomicCalls).toEqual([]);
  });

  it("rejects a plan that writes the same path twice", async () => {
    const fs = new MemFs();
    await expect(
      executePlan(
        [
          { kind: "write", path: "/a.json", before: null, after: "1" },
          { kind: "write", path: "/a.json", before: null, after: "2" },
        ],
        { fs, env: { homeDir: HOME }, action: "import", now: NOW },
      ),
    ).rejects.toThrow();
  });
});
