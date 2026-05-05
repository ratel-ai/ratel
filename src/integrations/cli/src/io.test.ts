import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type JsonFs, nodeJsonFs, readJson, writeJson } from "./io.js";
import * as fsAdapter from "./io-fs.js";

function memoryFs(): JsonFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(p) {
      return files.has(p) ? (files.get(p) as string) : null;
    },
    async writeAtomic(p, c) {
      files.set(p, c);
    },
    async exists(p) {
      return files.has(p);
    },
  };
}

describe("nodeJsonFs", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ratel-iotest-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writeAtomic creates the file when missing", async () => {
    const p = join(dir, "out.json");
    await nodeJsonFs.writeAtomic(p, "hello");
    expect(await readFile(p, "utf8")).toBe("hello");
  });

  it("writeAtomic overwrites existing content", async () => {
    const p = join(dir, "out.json");
    await writeFile(p, "old");
    await nodeJsonFs.writeAtomic(p, "new");
    expect(await readFile(p, "utf8")).toBe("new");
  });

  it("on rename failure, leaves the original file intact and removes the tmp file", async () => {
    const p = join(dir, "out.json");
    await writeFile(p, "ORIGINAL");
    const spy = vi.spyOn(fsAdapter, "rename").mockRejectedValueOnce(new Error("simulated"));
    await expect(nodeJsonFs.writeAtomic(p, "NEW")).rejects.toThrow("simulated");
    spy.mockRestore();
    expect(await readFile(p, "utf8")).toBe("ORIGINAL");
    const entries = (await readdir(dir)).filter((n) => n.includes("ratel-tmp"));
    expect(entries).toEqual([]);
  });

  it("read returns null on ENOENT", async () => {
    expect(await nodeJsonFs.read(join(dir, "missing.json"))).toBeNull();
  });

  it("read returns the file contents when present", async () => {
    const p = join(dir, "x.json");
    await writeFile(p, "abc");
    expect(await nodeJsonFs.read(p)).toBe("abc");
  });

  it("exists returns true/false correctly", async () => {
    const p = join(dir, "x.json");
    expect(await nodeJsonFs.exists(p)).toBe(false);
    await writeFile(p, "x");
    expect(await nodeJsonFs.exists(p)).toBe(true);
  });

  it("writeAtomic creates parent directories", async () => {
    const p = join(dir, "deep", "nested", "x.json");
    await nodeJsonFs.writeAtomic(p, "hi");
    expect(await readFile(p, "utf8")).toBe("hi");
  });
});

describe("readJson + writeJson", () => {
  it("writeJson formats with 2-space indentation and a trailing newline", async () => {
    const fs = memoryFs();
    await writeJson(fs, "/x.json", { a: 1, b: [2, 3] });
    expect(fs.files.get("/x.json")).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
  });

  it("readJson returns null on missing file", async () => {
    expect(await readJson(memoryFs(), "/missing.json")).toBeNull();
  });

  it("readJson parses JSON content correctly", async () => {
    const fs = memoryFs();
    fs.files.set("/x.json", '{"a":1}');
    expect(await readJson(fs, "/x.json")).toEqual({ a: 1 });
  });

  it("readJson throws on invalid JSON", async () => {
    const fs = memoryFs();
    fs.files.set("/x.json", "not json");
    await expect(readJson(fs, "/x.json")).rejects.toThrow();
  });
});
