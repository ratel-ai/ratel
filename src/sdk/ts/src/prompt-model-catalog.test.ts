import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_HOST_KEY,
  type CatalogHost,
  type CatalogRead,
  experimentalCatalogReads,
  ratel,
  resetCatalogForTest,
} from "./prompt-model-catalog.js";

const hostSlot = globalThis as { [CATALOG_HOST_KEY]?: CatalogHost };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ratel-catalog-"));
  vi.stubEnv("RATEL_CATALOG_FILE", join(dir, "ratel.catalog.json"));
  resetCatalogForTest();
});

afterEach(() => {
  delete hostSlot[CATALOG_HOST_KEY];
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function writeCatalog(content: unknown): void {
  writeFileSync(join(dir, "ratel.catalog.json"), JSON.stringify(content));
}

describe("ratel.prompt / ratel.model resolution", () => {
  it("returns the default with no host and no catalog file", () => {
    expect(ratel.prompt("system", "You are terse.")).toBe("You are terse.");
    expect(ratel.model("answer", "anthropic/claude-haiku-5-5")).toBe("anthropic/claude-haiku-5-5");
  });

  it("returns the catalog value over the default", () => {
    writeCatalog({
      prompts: { system: "From the catalog." },
      models: { answer: "openai/gpt-5" },
    });
    expect(ratel.prompt("system", "default")).toBe("From the catalog.");
    expect(ratel.model("answer", "anthropic/x")).toBe("openai/gpt-5");
    expect(ratel.prompt("other", "fallback")).toBe("fallback");
  });

  it("returns the run override of the active sandbox over the catalog value", () => {
    writeCatalog({ prompts: { system: "From the catalog." }, models: { answer: "openai/gpt-5" } });
    hostSlot[CATALOG_HOST_KEY] = {
      resolve: (kind, id) => (kind === "prompt" && id === "system" ? "Overridden." : undefined),
      record: () => {},
    };
    expect(ratel.prompt("system", "default")).toBe("Overridden.");
    expect(ratel.model("answer", "anthropic/x")).toBe("openai/gpt-5");
  });

  it("finds ratel.catalog.json in the working directory when no env path is set", () => {
    vi.stubEnv("RATEL_CATALOG_FILE", "");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    writeCatalog({ prompts: { system: "cwd catalog" } });
    expect(ratel.prompt("system", "default")).toBe("cwd catalog");
    cwd.mockRestore();
  });

  it("rejects a catalog file with a non-string value, naming the file and the entry", () => {
    writeCatalog({ prompts: { system: 42 } });
    expect(() => ratel.prompt("system", "d")).toThrow(/ratel\.catalog\.json.*prompts\.system/);
  });

  it("rejects an empty id", () => {
    expect(() => ratel.prompt("", "d")).toThrow(/id/);
  });
});

describe("registry of reads", () => {
  it("records each prompt and model read with its default, once per kind and id", () => {
    ratel.prompt("system", "a");
    ratel.prompt("system", "a");
    ratel.model("answer", "anthropic/x");
    expect(experimentalCatalogReads()).toEqual<CatalogRead[]>([
      { kind: "prompt", id: "system", default: "a" },
      { kind: "model", id: "answer", default: "anthropic/x" },
    ]);
  });

  it("reports each read to the active host", () => {
    const record = vi.fn();
    hostSlot[CATALOG_HOST_KEY] = { resolve: () => undefined, record };
    ratel.model("answer", "anthropic/x");
    expect(record).toHaveBeenCalledWith({ kind: "model", id: "answer", default: "anthropic/x" });
  });
});

describe("purity", () => {
  it("opens no socket and calls no fetch on import or call", async () => {
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.resetModules();
    const mod = await import("./prompt-model-catalog.js");
    writeCatalog({ prompts: { system: "x" } });
    mod.ratel.prompt("system", "d");
    mod.ratel.model("answer", "anthropic/x");
    expect(connect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    connect.mockRestore();
    fetchSpy.mockRestore();
  });

  it("is published on its own entrypoint and leaves the root entry unchanged", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.exports["./experimental/catalog"]).toEqual({
      types: "./dist/prompt-model-catalog.d.ts",
      default: "./dist/prompt-model-catalog.js",
    });
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).not.toMatch(/prompt-model-catalog/);
  });
});
