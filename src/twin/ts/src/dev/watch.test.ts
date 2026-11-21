import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_WATCHED_DIRS, type WatchFn, watchedDirs, watchProject } from "./watch.js";

// The hot-reload watcher of `ratel dev`: it watches only the folders of the
// twin files and their local imports (never node_modules, .git or build
// output), a bounded number of them, and a watcher error turns hot reload off
// instead of crashing the runner.

const projects: string[] = [];

afterEach(() => {
  for (const p of projects.splice(0)) rmSync(p, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ratel-watch-"));
  projects.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A large dependency tree and build output that the watcher must never enter. */
function addHeavyTrees(root: string): void {
  for (let i = 0; i < 300; i++) {
    mkdirSync(join(root, "node_modules", `pkg-${i}`, "lib"), { recursive: true });
    writeFileSync(join(root, "node_modules", `pkg-${i}`, "lib", "a.twin.ts"), "export {};\n");
  }
  mkdirSync(join(root, "dist", "agents"), { recursive: true });
  writeFileSync(join(root, "dist", "agents", "copy.twin.js"), "export {};\n");
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
}

/** A watch function that records what it watched and lets a test fail it. */
function fakeWatch() {
  const watched: { dir: string; recursive: boolean; closed: boolean }[] = [];
  const emitters: EventEmitter[] = [];
  const watch: WatchFn = (dir, options) => {
    const emitter = Object.assign(new EventEmitter(), {
      close: () => {
        entry.closed = true;
      },
    });
    const entry = { dir, recursive: Boolean(options.recursive), closed: false };
    watched.push(entry);
    emitters.push(emitter);
    return emitter;
  };
  return { watch, watched, emitters };
}

describe("watchedDirs", () => {
  it("lists the folders of the twin files and of their local imports, and the project root", () => {
    const root = project({
      "agents/docs.twin.ts": 'import { reply } from "./src/agent.js";\nexport default reply;\n',
      "agents/src/agent.ts":
        'import { tools } from "../../shared/tools";\nexport const reply = tools;\n',
      "shared/tools.ts": 'import { z } from "zod";\nexport const tools = z;\n',
      "unrelated/other.ts": "export {};\n",
    });
    addHeavyTrees(root);
    const { dirs, truncated } = watchedDirs(root);
    expect(dirs).toEqual([".", "agents", "agents/src", "shared"]);
    expect(truncated).toBe(false);
  });

  it("never enters node_modules, .git or build output, however large", () => {
    const root = project({ "a.twin.ts": "export {};\n" });
    addHeavyTrees(root);
    const { dirs } = watchedDirs(root);
    expect(dirs).toEqual(["."]);
    expect(dirs.some((d) => /node_modules|\.git|dist/.test(d))).toBe(false);
  });

  it("stops at MAX_WATCHED_DIRS folders", () => {
    const files: Record<string, string> = {};
    const imports: string[] = [];
    for (let i = 0; i < MAX_WATCHED_DIRS + 40; i++) {
      files[`lib/m${i}/index.ts`] = "export const x = 1;\n";
      imports.push(`import "./lib/m${i}/index.js";`);
    }
    files["a.twin.ts"] = `${imports.join("\n")}\nexport {};\n`;
    const { dirs, truncated } = watchedDirs(project(files));
    expect(dirs).toHaveLength(MAX_WATCHED_DIRS);
    expect(truncated).toBe(true);
  });
});

describe("watchProject", () => {
  it("watches each folder on its own, never recursively", () => {
    const root = project({ "a.twin.ts": 'import "./src/x.js";\n', "src/x.ts": "export {};\n" });
    addHeavyTrees(root);
    const fake = fakeWatch();
    const watcher = watchProject(root, { onChange: () => {}, onError: () => {} }, fake);
    expect(fake.watched.map((w) => [w.dir, w.recursive])).toEqual([
      [root, false],
      [join(root, "src"), false],
    ]);
    watcher.close();
    expect(fake.watched.every((w) => w.closed)).toBe(true);
  });

  it("turns hot reload off on a watcher error, once, without throwing", () => {
    const root = project({ "a.twin.ts": 'import "./src/x.js";\n', "src/x.ts": "export {};\n" });
    const fake = fakeWatch();
    const errors: string[] = [];
    watchProject(root, { onChange: () => {}, onError: (m) => errors.push(m) }, fake);
    const emfile = Object.assign(new Error("EMFILE: too many open files, watch"), {
      code: "EMFILE",
    });
    for (const emitter of fake.emitters) emitter.emit("error", emfile);
    expect(errors).toEqual(["EMFILE: too many open files, watch"]);
    expect(fake.watched.every((w) => w.closed)).toBe(true);
  });

  it("turns hot reload off when watch() throws", () => {
    const root = project({ "a.twin.ts": "export {};\n" });
    const errors: string[] = [];
    const throwing: WatchFn = () => {
      throw Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" });
    };
    const watcher = watchProject(
      root,
      { onChange: () => {}, onError: (m) => errors.push(m) },
      { watch: throwing },
    );
    expect(errors).toEqual(["EMFILE: too many open files, watch"]);
    expect(watcher.dirs).toEqual([]);
  });

  it("calls onChange once per burst of changes in a watched folder, and ignores other dot-files", async () => {
    const root = project({ "a.twin.ts": 'import "./src/x.js";\n', "src/x.ts": "export {};\n" });
    let changes = 0;
    const watcher = watchProject(root, {
      onChange: () => {
        changes++;
      },
      onError: (m) => {
        throw new Error(m);
      },
    });
    try {
      // FSEvents can deliver the writes of the setup late: let them settle first.
      await new Promise((r) => setTimeout(r, 700));
      changes = 0;
      writeFileSync(join(root, ".DS_Store"), "x");
      await new Promise((r) => setTimeout(r, 400));
      expect(changes).toBe(0);
      writeFileSync(join(root, "src", "x.ts"), "export const y = 2;\n");
      writeFileSync(join(root, ".env"), "A=1\n");
      await expect.poll(() => changes, { timeout: 3000 }).toBe(1);
    } finally {
      watcher.close();
    }
  });

  it("refresh() adds the folder of a new import", () => {
    const root = project({ "a.twin.ts": "export {};\n", "src/x.ts": "export {};\n" });
    const fake = fakeWatch();
    const watcher = watchProject(root, { onChange: () => {}, onError: () => {} }, fake);
    expect(watcher.dirs).toEqual(["."]);
    writeFileSync(join(root, "a.twin.ts"), 'import "./src/x.js";\n');
    watcher.refresh();
    expect(watcher.dirs).toEqual([".", "src"]);
    watcher.close();
  });
});
