import { describe, expect, it } from "vitest";
import { listBackups, restoreLatest, startBackup } from "./backup.js";

const HOME = "/home/u";

class MemFs {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async read(p: string): Promise<string | null> {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  async write(p: string, c: string): Promise<void> {
    this.files.set(p, c);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
  }
  async mkdirp(p: string): Promise<void> {
    this.dirs.add(p);
  }
  async list(p: string): Promise<string[]> {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    const names = new Set<string>();
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf("/");
        names.add(slash >= 0 ? rest.slice(0, slash) : rest);
      }
    }
    return Array.from(names).sort();
  }
}

const stableNow = (i: number) => new Date(`2026-05-03T12:0${i}:00Z`);

describe("startBackup + finalize", () => {
  it("creates a timestamped backup dir under ~/.ratel/backups and copies captured files in", async () => {
    const fs = new MemFs();
    fs.files.set("/etc/foo.json", '{"a":1}');
    const session = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    await session.capture("/etc/foo.json");
    const manifest = await session.finalize("add");

    expect(session.dir.startsWith("/home/u/.ratel/backups/")).toBe(true);
    expect(session.dir).not.toContain(":");
    expect(manifest.action).toBe("add");
    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0];
    expect(entry.originalPath).toBe("/etc/foo.json");
    expect(entry.existedBefore).toBe(true);
    expect(fs.files.get(entry.backupPath)).toBe('{"a":1}');
  });

  it("records existedBefore=false for a captured path that doesn't exist", async () => {
    const fs = new MemFs();
    const session = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    await session.capture("/etc/missing.json");
    const m = await session.finalize("import");
    expect(m.entries[0].existedBefore).toBe(false);
  });

  it("writes a manifest.json listing every captured file", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "A");
    fs.files.set("/b.json", "B");
    const session = startBackup({ homeDir: HOME }, fs, () => stableNow(1));
    await session.capture("/a.json");
    await session.capture("/b.json");
    const m = await session.finalize("import");
    const onDisk = JSON.parse((await fs.read(`${session.dir}/manifest.json`)) as string);
    expect(onDisk).toEqual(m);
    expect(m.entries.map((e) => e.originalPath).sort()).toEqual(["/a.json", "/b.json"]);
  });

  it("is idempotent on a double-capture of the same path within one session", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "first");
    const session = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    await session.capture("/a.json");
    fs.files.set("/a.json", "second"); // simulate change
    await session.capture("/a.json");
    const m = await session.finalize("add");
    expect(m.entries).toHaveLength(1);
    expect(fs.files.get(m.entries[0].backupPath)).toBe("first");
  });

  it("uses a filesystem-safe ISO timestamp (no colons) for the dir name", async () => {
    const fs = new MemFs();
    const session = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    expect(session.dir).not.toContain(":");
  });
});

describe("listBackups", () => {
  it("returns an empty list when no backups exist", async () => {
    const fs = new MemFs();
    expect(await listBackups({ homeDir: HOME }, fs)).toEqual([]);
  });

  it("returns manifests sorted newest-first", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "A");
    fs.files.set("/b.json", "B");
    const s1 = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    await s1.capture("/a.json");
    await s1.finalize("import");
    const s2 = startBackup({ homeDir: HOME }, fs, () => stableNow(1));
    await s2.capture("/b.json");
    await s2.finalize("add");

    const list = await listBackups({ homeDir: HOME }, fs);
    expect(list).toHaveLength(2);
    expect(list[0].action).toBe("add");
    expect(list[1].action).toBe("import");
  });

  it("ignores backup directories that have no manifest", async () => {
    const fs = new MemFs();
    fs.files.set("/home/u/.ratel/backups/abandoned/something.txt", "x");
    expect(await listBackups({ homeDir: HOME }, fs)).toEqual([]);
  });
});

describe("restoreLatest", () => {
  it("returns null when no backups exist", async () => {
    expect(await restoreLatest({ homeDir: HOME }, new MemFs())).toBeNull();
  });

  it("restores the most recent set's contents byte-for-byte", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "OLD");
    const s = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    await s.capture("/a.json");
    await s.finalize("add");
    fs.files.set("/a.json", "NEW");

    await restoreLatest({ homeDir: HOME }, fs);
    expect(fs.files.get("/a.json")).toBe("OLD");
  });

  it("deletes files that did not exist before the captured action", async () => {
    const fs = new MemFs();
    const s = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    await s.capture("/created.json"); // existedBefore=false
    await s.finalize("add");
    fs.files.set("/created.json", "wrote-after");

    await restoreLatest({ homeDir: HOME }, fs);
    expect(fs.files.has("/created.json")).toBe(false);
  });

  it("restores only the most recent set when multiple exist", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "v1");
    const s1 = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    await s1.capture("/a.json");
    await s1.finalize("add");
    fs.files.set("/a.json", "v2");

    const s2 = startBackup({ homeDir: HOME }, fs, () => stableNow(1));
    await s2.capture("/a.json");
    await s2.finalize("remove");
    fs.files.set("/a.json", "v3");

    await restoreLatest({ homeDir: HOME }, fs);
    expect(fs.files.get("/a.json")).toBe("v2");
  });
});
