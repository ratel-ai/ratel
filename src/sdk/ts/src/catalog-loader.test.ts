import { describe, expect, it } from "vitest";
import { attachLoader, type CatalogLoader, type Skill, SkillCatalog } from "./index.js";

/** A loader that records its lifecycle calls and mirrors a fixed skill set. */
class FakeLoader implements CatalogLoader {
  readonly calls: string[] = [];
  catalog: SkillCatalog | undefined;
  /** Phases configured to throw on their next call. */
  readonly throwOn = new Set<"start" | "stop" | "refresh">();

  constructor(
    private skills: Skill[] = [],
    /** When true, every method returns a resolved promise (async loader). */
    private readonly async = true,
  ) {}

  start(catalog: SkillCatalog): void | Promise<void> {
    this.calls.push("start");
    this.catalog = catalog;
    return this.run("start", () => this.mirror(catalog));
  }

  stop(): void | Promise<void> {
    this.calls.push("stop");
    return this.run("stop", () => {});
  }

  refresh(): void | Promise<void> {
    this.calls.push("refresh");
    return this.run("refresh", () => this.mirror(this.catalog));
  }

  /** Swap the skill set a later refresh will mirror. */
  setSkills(skills: Skill[]): void {
    this.skills = skills;
  }

  /** An async loader awaits each `upsert`; a sync one fires and forgets (metadata
   * still commits synchronously, so a BM25 catalog hydrates either way). */
  private mirror(catalog: SkillCatalog | undefined): void | Promise<void> {
    if (!catalog) return;
    if (this.async) {
      return (async () => {
        for (const skill of this.skills) {
          await catalog.upsert(skill);
        }
      })();
    }
    for (const skill of this.skills) {
      void catalog.upsert(skill);
    }
  }

  private run(
    phase: "start" | "stop" | "refresh",
    work: () => void | Promise<void>,
  ): void | Promise<void> {
    const act = () => {
      if (this.throwOn.has(phase)) {
        throw new Error(`fake loader ${phase} failure`);
      }
      return work();
    };
    if (this.async) {
      return Promise.resolve().then(act);
    }
    act();
  }
}

const slides: Skill = {
  id: "frontend-slides",
  name: "frontend-slides",
  description: "Build animation-rich HTML presentations from scratch.",
  tags: ["frontend"],
  body: "# Slides",
};

const apiDesign: Skill = {
  id: "api-design",
  name: "api-design",
  description: "REST API design patterns: resource naming, pagination.",
  tags: ["backend"],
  body: "# API",
};

describe("attachLoader", () => {
  it("calls start with the catalog, hydrating it before resolving", async () => {
    const catalog = new SkillCatalog();
    let changes = 0;
    catalog.onChange(() => {
      changes += 1;
    });
    const loader = new FakeLoader([slides, apiDesign]);

    const handle = await attachLoader(catalog, loader);

    expect(loader.calls).toEqual(["start"]);
    expect(loader.catalog).toBe(catalog);
    // Hydration is complete by the time attach resolves.
    expect(catalog.size()).toBe(2);
    expect(changes).toBe(2);
    expect(handle).toMatchObject({ detach: expect.any(Function), refresh: expect.any(Function) });
  });

  it("absorbs a fully synchronous loader (no promise returned from start)", async () => {
    const catalog = new SkillCatalog();
    const loader = new FakeLoader([slides], /* async */ false);

    await attachLoader(catalog, loader);

    expect(catalog.has("frontend-slides")).toBe(true);
  });

  it("detach stops the loader exactly once and is idempotent", async () => {
    const catalog = new SkillCatalog();
    const loader = new FakeLoader([slides]);
    const handle = await attachLoader(catalog, loader);

    await handle.detach();
    await handle.detach();

    expect(loader.calls).toEqual(["start", "stop"]);
    // Detaching keeps the hydrated skills in the catalog.
    expect(catalog.has("frontend-slides")).toBe(true);
  });

  it("handle.refresh passes through to the loader's refresh", async () => {
    const catalog = new SkillCatalog();
    const loader = new FakeLoader([slides]);
    const handle = await attachLoader(catalog, loader);

    loader.setSkills([slides, apiDesign]);
    await handle.refresh();

    expect(loader.calls).toEqual(["start", "refresh"]);
    expect(catalog.size()).toBe(2);
  });

  it("handle.refresh rejects when the loader's refresh throws", async () => {
    const catalog = new SkillCatalog();
    const loader = new FakeLoader([slides]);
    const handle = await attachLoader(catalog, loader);

    loader.throwOn.add("refresh");
    await expect(handle.refresh()).rejects.toThrow(/fake loader refresh failure/);
  });

  it("rejects a double-attach of the same loader instance", async () => {
    const catalog = new SkillCatalog();
    const loader = new FakeLoader([slides]);
    await attachLoader(catalog, loader);

    await expect(attachLoader(catalog, loader)).rejects.toThrow(/already attached/);
    // The original loop was untouched — start ran once.
    expect(loader.calls).toEqual(["start"]);
  });

  it("supports detach-then-reattach (start runs again)", async () => {
    const catalog = new SkillCatalog();
    const loader = new FakeLoader([slides]);
    const handle = await attachLoader(catalog, loader);
    await handle.detach();

    const reHandle = await attachLoader(catalog, loader);

    expect(loader.calls).toEqual(["start", "stop", "start"]);
    await reHandle.detach();
  });

  it("a start failure keeps partial hydration and re-allows attaching", async () => {
    const catalog = new SkillCatalog();
    // Loader commits one upsert, then start throws.
    class PartialLoader extends FakeLoader {
      override start(cat: SkillCatalog): Promise<void> {
        this.catalog = cat;
        this.calls.push("start");
        return Promise.resolve().then(async () => {
          await cat.upsert(slides);
          throw new Error("start blew up after one upsert");
        });
      }
    }
    const loader = new PartialLoader();

    await expect(attachLoader(catalog, loader)).rejects.toThrow(/start blew up/);
    // The committed upsert stays — the SDK has no snapshot to roll back.
    expect(catalog.has("frontend-slides")).toBe(true);

    // ...and the loader is re-attachable (guard was cleared on failure).
    loader.calls.length = 0;
    await expect(attachLoader(catalog, loader)).rejects.toThrow(/start blew up/);
    expect(loader.calls).toEqual(["start"]);
  });

  it("a stop failure propagates but still detaches (second detach is a no-op)", async () => {
    const catalog = new SkillCatalog();
    const loader = new FakeLoader([slides]);
    const handle = await attachLoader(catalog, loader);

    loader.throwOn.add("stop");
    await expect(handle.detach()).rejects.toThrow(/fake loader stop failure/);

    // Marked detached despite the throw: a second detach neither re-stops nor throws.
    loader.throwOn.delete("stop");
    await expect(handle.detach()).resolves.toBeUndefined();
    expect(loader.calls).toEqual(["start", "stop"]);

    // Detached-out means the loader can be attached fresh.
    const reHandle = await attachLoader(catalog, loader);
    expect(loader.calls).toEqual(["start", "stop", "start"]);
    await reHandle.detach();
  });
});
