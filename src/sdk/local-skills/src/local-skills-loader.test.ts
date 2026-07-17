import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { attachLoader, SkillCatalog } from "@ratel-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSkillsLoader } from "./index.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ratel-local-skills-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write `<root>/<name>/SKILL.md` with the given contents. */
async function writeSkill(name: string, content: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content);
}

describe("LocalSkillsLoader — start & parse", () => {
  it("defaults the directory to ~/.ratel/skills", () => {
    expect(new LocalSkillsLoader().dir).toBe(join(homedir(), ".ratel", "skills"));
  });

  it("hydrates the catalog from <dir>/*/SKILL.md on start", async () => {
    await writeSkill(
      "api-design",
      "---\ndescription: REST API design patterns, resource naming, pagination.\n---\n# API Design\n\nUse nouns for resources.",
    );
    await writeSkill(
      "frontend-slides",
      "---\ndescription: Build animation-rich HTML presentations.\n---\n# Slides",
    );
    const catalog = new SkillCatalog();

    await new LocalSkillsLoader({ dir: root }).start(catalog);

    expect(catalog.size()).toBe(2);
    const hits = catalog.search("design a REST endpoint with pagination", 5);
    expect(hits[0].skillId).toBe("api-design");
    expect(catalog.invoke("api-design")).toContain("Use nouns for resources.");
  });

  it("uses the frontmatter id over the dirname and defaults name to id", async () => {
    await writeSkill("dir-name", "---\nid: real-id\ndescription: An explicit id.\n---\nbody");
    const catalog = new SkillCatalog();

    await new LocalSkillsLoader({ dir: root }).start(catalog);

    expect(catalog.has("real-id")).toBe(true);
    expect(catalog.has("dir-name")).toBe(false);
    expect(catalog.get("real-id")?.name).toBe("real-id");
  });

  it("defaults the id to the directory name when the frontmatter omits it", async () => {
    await writeSkill("my-skill", "---\ndescription: no explicit id.\n---\nbody");
    const catalog = new SkillCatalog();

    await new LocalSkillsLoader({ dir: root }).start(catalog);

    expect(catalog.has("my-skill")).toBe(true);
  });

  it("defaults tags, tools, and metadata to empty when omitted", async () => {
    await writeSkill("min", "---\ndescription: minimal skill.\n---\nbody");
    const catalog = new SkillCatalog();

    await new LocalSkillsLoader({ dir: root }).start(catalog);

    const skill = catalog.get("min");
    expect(skill?.tags).toEqual([]);
    expect(skill?.tools).toEqual([]);
    expect(skill?.metadata).toEqual({});
  });

  it("round-trips a full frontmatter (inline and block lists, both metadata forms)", async () => {
    await writeSkill(
      "full",
      [
        "---",
        "id: full-skill",
        "name: Full Skill",
        "description: Everything set.",
        "tags: [frontend, login form]",
        "tools:",
        "  - read_file",
        "  - write_file",
        "metadata:",
        "  stacks: [react, next]",
        "  langs:",
        "    - ts",
        "---",
        "# Body",
      ].join("\n"),
    );
    const catalog = new SkillCatalog();

    await new LocalSkillsLoader({ dir: root }).start(catalog);

    const skill = catalog.get("full-skill");
    expect(skill?.name).toBe("Full Skill");
    expect(skill?.description).toBe("Everything set.");
    expect(skill?.tags).toEqual(["frontend", "login form"]);
    expect(skill?.tools).toEqual(["read_file", "write_file"]);
    expect(skill?.metadata).toEqual({ stacks: ["react", "next"], langs: ["ts"] });
  });

  it("extracts the markdown body verbatim, trimming only leading blank lines", async () => {
    await writeSkill("b", "---\ndescription: d\n---\n\n\n# Title\n\nLine 1\n  indented\n");
    const catalog = new SkillCatalog();

    await new LocalSkillsLoader({ dir: root }).start(catalog);

    expect(catalog.invoke("b")).toBe("# Title\n\nLine 1\n  indented\n");
  });

  it("skips malformed files, loads their siblings, and records a diagnostic each", async () => {
    await writeSkill("good", "---\ndescription: a good skill.\n---\nbody");
    await writeSkill("no-fence", "no frontmatter here");
    await writeSkill("no-desc", "---\nname: x\n---\nbody");
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: root });

    await loader.start(catalog);

    expect(catalog.has("good")).toBe(true);
    expect(catalog.size()).toBe(1);
    expect(loader.diagnostics).toHaveLength(2);
    expect(loader.diagnostics.some((d) => d.path.includes("no-fence"))).toBe(true);
    expect(loader.diagnostics.some((d) => d.path.includes("no-desc"))).toBe(true);
  });

  it("diagnoses a wrong-typed field instead of loading a broken skill", async () => {
    await writeSkill("bad-tags", "---\ndescription: d\ntags: not-a-list\n---\nbody");
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: root });

    await loader.start(catalog);

    expect(catalog.has("bad-tags")).toBe(false);
    expect(loader.diagnostics[0]?.reason).toMatch(/tags/);
  });

  it("parses YAML 1.1 like the Python mirror: unquoted on/off/yes/no are booleans", async () => {
    // `on` resolves to a boolean under YAML 1.1, so an unquoted one in a tag list is not a
    // string — rejected here exactly as `pyyaml.safe_load` rejects it in the Python loader.
    await writeSkill("bool-tag", "---\ndescription: d\ntags: [ci, on]\n---\nbody");
    // Quoting keeps it a string, and loads in both SDKs.
    await writeSkill("quoted-tag", '---\ndescription: d\ntags: ["ci", "on"]\n---\nbody');
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: root });

    await loader.start(catalog);

    expect(catalog.has("bool-tag")).toBe(false);
    expect(
      loader.diagnostics.some((d) => d.path.includes("bool-tag") && d.reason.includes("tags")),
    ).toBe(true);
    expect(catalog.get("quoted-tag")?.tags).toEqual(["ci", "on"]);
  });

  it("takes the last value of a duplicate frontmatter key (lenient, like the Python mirror)", async () => {
    await writeSkill("dup", "---\ndescription: first\ndescription: second\n---\nbody");
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: root });

    await loader.start(catalog);

    expect(catalog.has("dup")).toBe(true);
    expect(catalog.get("dup")?.description).toBe("second");
    expect(loader.diagnostics).toEqual([]);
  });

  it("starts empty (no diagnostics) when the directory does not exist", async () => {
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: join(root, "does-not-exist") });

    await loader.start(catalog);

    expect(catalog.size()).toBe(0);
    expect(loader.diagnostics).toEqual([]);
  });

  it("ignores directories that have no SKILL.md", async () => {
    await mkdir(join(root, "empty-dir"), { recursive: true });
    await writeSkill("real", "---\ndescription: d\n---\nbody");
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: root });

    await loader.start(catalog);

    expect(catalog.size()).toBe(1);
    expect(loader.diagnostics).toEqual([]);
  });

  it("keeps the first (sorted) of a duplicate id and diagnoses the rest", async () => {
    await writeSkill("a-dir", "---\nid: dup\ndescription: first wins.\n---\nfirst");
    await writeSkill("b-dir", "---\nid: dup\ndescription: second loses.\n---\nsecond");
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: root });

    await loader.start(catalog);

    expect(catalog.size()).toBe(1);
    expect(catalog.invoke("dup")).toBe("first");
    expect(
      loader.diagnostics.some((d) => d.reason.includes("duplicate") && d.path.includes("b-dir")),
    ).toBe(true);
  });

  it("throws on a second start without an intervening stop", async () => {
    await writeSkill("s", "---\ndescription: d\n---\nbody");
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: root });
    await loader.start(catalog);

    await expect(loader.start(catalog)).rejects.toThrow(/already started/);
  });
});

describe("LocalSkillsLoader — refresh & lifecycle", () => {
  it("throws when refresh is called before start", async () => {
    const loader = new LocalSkillsLoader({ dir: root });
    await expect(loader.refresh()).rejects.toThrow(/not started/);
  });

  it("refresh adds newly-appeared skills", async () => {
    await writeSkill("first", "---\ndescription: the first skill.\n---\nbody");
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: root });
    await loader.start(catalog);
    expect(catalog.size()).toBe(1);

    await writeSkill("second", "---\ndescription: the second skill.\n---\nbody");
    await loader.refresh();

    expect(catalog.size()).toBe(2);
    expect(catalog.has("second")).toBe(true);
  });

  it("refresh serves the updated body after a file changes", async () => {
    await writeSkill("s", "---\ndescription: d\n---\noriginal body");
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: root });
    await loader.start(catalog);
    expect(catalog.invoke("s")).toBe("original body");

    await writeSkill("s", "---\ndescription: d\n---\nrewritten body");
    await loader.refresh();

    expect(catalog.size()).toBe(1);
    expect(catalog.invoke("s")).toBe("rewritten body");
  });

  it("refresh removes a skill whose directory vanished", async () => {
    await writeSkill("keep", "---\ndescription: keeper.\n---\nbody");
    await writeSkill("drop", "---\ndescription: goner.\n---\nbody");
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: root });
    await loader.start(catalog);
    expect(catalog.size()).toBe(2);

    await rm(join(root, "drop"), { recursive: true, force: true });
    await loader.refresh();

    expect(catalog.has("keep")).toBe(true);
    expect(catalog.has("drop")).toBe(false);
    expect(catalog.size()).toBe(1);
  });

  it("refresh never removes a foreign skill another writer added", async () => {
    await writeSkill("owned", "---\ndescription: loader-owned.\n---\nbody");
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: root });
    await loader.start(catalog);
    // A different writer pushes a skill the loader never loaded.
    await catalog.upsert({
      id: "foreign",
      name: "foreign",
      description: "put here by someone else",
    });
    expect(catalog.size()).toBe(2);

    await loader.refresh();

    expect(catalog.has("foreign")).toBe(true);
    expect(catalog.has("owned")).toBe(true);
  });

  it("refresh skips unchanged files — onChange fires only for the touched skill", async () => {
    await writeSkill("a", "---\ndescription: skill a.\n---\nbody a");
    await writeSkill("b", "---\ndescription: skill b.\n---\nbody b");
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: root });
    await loader.start(catalog);

    let changes = 0;
    catalog.onChange(() => {
      changes += 1;
    });
    // Touch only `b`.
    await writeSkill("b", "---\ndescription: skill b.\n---\nbody b rewritten");
    await loader.refresh();

    expect(changes).toBe(1);
    expect(catalog.invoke("a")).toBe("body a");
    expect(catalog.invoke("b")).toBe("body b rewritten");
  });

  it("stop keeps the skills; start-after-stop re-scans; state resets", async () => {
    await writeSkill("s", "---\ndescription: d\n---\nbody");
    const catalog = new SkillCatalog();
    const loader = new LocalSkillsLoader({ dir: root });
    await loader.start(catalog);

    await loader.stop();
    // Skills survive a stop (offline semantics).
    expect(catalog.has("s")).toBe(true);
    expect(loader.diagnostics).toEqual([]);

    // A new skill added while stopped is picked up on the next start.
    await writeSkill("t", "---\ndescription: added while stopped.\n---\nbody");
    await loader.start(catalog);
    expect(catalog.size()).toBe(2);
    expect(catalog.has("t")).toBe(true);
  });

  it("integrates with attachLoader: hydrates on attach and refresh picks up an edit", async () => {
    await writeSkill("one", "---\ndescription: skill one.\n---\nbody one");
    const catalog = new SkillCatalog();

    const handle = await attachLoader(catalog, new LocalSkillsLoader({ dir: root }));
    expect(catalog.has("one")).toBe(true);

    await writeSkill("two", "---\ndescription: skill two.\n---\nbody two");
    await handle.refresh();
    expect(catalog.size()).toBe(2);
    expect(catalog.has("two")).toBe(true);

    await handle.detach();
    // Detach keeps the last-synced skills.
    expect(catalog.has("one")).toBe(true);
  });
});
