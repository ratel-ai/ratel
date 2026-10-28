import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { classifySpecifier, layerOf, scanLayers } from "./check-layers.mjs";

let lib;
const file = (rel, body) => {
  const full = join(lib, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
};

describe("check-layers", () => {
  beforeEach(() => {
    lib = mkdtempSync(join(tmpdir(), "ratel-layers-"));
  });
  afterEach(() => rmSync(lib, { recursive: true, force: true }));

  it("maps a path to its layer and flags files outside every layer", () => {
    assert.deepEqual(layerOf("readings/intent-engine/engine.ts"), { layer: "readings", level: 4 });
    assert.equal(layerOf("runtime.ts"), null);
  });

  it("classifies alias, relative, UI and external specifiers", () => {
    assert.deepEqual(classifySpecifier("@/lib/platform/db", "readings/x.ts"), { kind: "lib", rel: "platform/db" });
    assert.deepEqual(classifySpecifier("../platform/db", "readings/x.ts"), { kind: "lib", rel: "platform/db" });
    assert.deepEqual(classifySpecifier("../../components/ds/button", "readings/x.ts"), { kind: "ui" });
    assert.deepEqual(classifySpecifier("@/components/x", "readings/x.ts"), { kind: "ui" });
    assert.deepEqual(classifySpecifier("drizzle-orm", "readings/x.ts"), { kind: "external" });
    assert.deepEqual(classifySpecifier("#ee-composition", "composition/ports.ts"), { kind: "external" });
  });

  it("allows downward and same-layer imports, rejects upward ones", () => {
    file("platform/db/client.ts", 'import { x } from "@/lib/readings/intent-engine/engine";\n');
    file("readings/intent-engine/engine.ts", 'import { db } from "@/lib/platform/db/client";\nimport { t } from "../topics/types";\n');
    file("readings/topics/types.ts", "export const t = 1;\n");
    file("ingest/otlp/a.ts", 'import { b } from "@/lib/ingest/trace-events/b";\n');
    const { violations, stale } = scanLayers({ libRoot: lib });
    assert.deepEqual(stale, []);
    assert.deepEqual(
      violations.map((v) => `${v.path}:${v.specifier}`),
      ["platform/db/client.ts:@/lib/readings/intent-engine/engine"],
    );
    assert.match(violations[0].reason, /platform \(L1\) imports readings \(L4\)/);
  });

  it("rejects UI imports from lib, except in tests", () => {
    file("views/home/a.ts", 'import { Button } from "@/components/ds/button";\n');
    file("views/home/a.test.ts", 'import { Button } from "@/components/ds/button";\n');
    const { violations } = scanLayers({ libRoot: lib });
    assert.deepEqual(violations.map((v) => v.path), ["views/home/a.ts"]);
    assert.equal(violations[0].reason, "lib/ imports the UI");
  });

  it("exempts the composition root and flags files outside every layer", () => {
    file("composition/registry.ts", 'import { r } from "@/lib/mcp/register";\n');
    file("runtime.ts", 'import { c } from "@/lib/composition/ports";\n');
    const { violations } = scanLayers({ libRoot: lib });
    assert.deepEqual(violations.map((v) => [v.path, v.reason]), [["runtime.ts", "file is outside every layer"]]);
  });

  it("ratchets: an allowlist entry silences a violation and a stale entry is reported", () => {
    file("platform/a.ts", 'import { x } from "@/lib/jobs/x";\nimport { y } from "@/lib/mcp/y";\n');
    const allow = ["platform/a.ts:@/lib/mcp/y", "platform/gone.ts:@/lib/mcp/z"];
    const { violations, stale } = scanLayers({ libRoot: lib, allow });
    assert.deepEqual(violations, []);
    assert.deepEqual(stale, ["platform/gone.ts:@/lib/mcp/z"]);
  });
});
