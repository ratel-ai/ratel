import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { findPrivateStrings } from "./private-strings.mjs";
import { buildRules, rewriteSpecifiers } from "./rewrite-imports.mjs";
import { applySync, planSync } from "./sync.mjs";

const MAP = {
  entries: [
    { from: "apps/web/lib/otlp", to: "apps/web/lib/ingest/otlp", mode: "copy" },
    { from: "apps/web/lib/db/index.ts", to: "apps/web/lib/platform/db/client.ts", mode: "owned" },
    { from: "apps/web/lib/stripe", mode: "excluded" },
    { from: "apps/web/lib/otlp/billing-hook.ts", mode: "excluded" },
  ],
};
const REWRITES = {
  rules: [
    { from: "@/components/ds/", to: "@ratel/design-system/", except: ["@/components/ds/entity", "@/components/ds/dot-loader"] },
    { from: "@/lib/utils", to: "@ratel/design-system/cn", exact: true },
  ],
};

let source;
let repo;
const put = (root, rel, body) => {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
};
const read = (rel) => readFileSync(join(repo, rel), "utf8");

describe("rewrite-imports", () => {
  const rules = buildRules(MAP, REWRITES);

  it("derives lib rules from the map, longest first, and keeps explicit rules", () => {
    assert.deepEqual(
      rules.map((r) => [r.from, r.to]),
      [
        ["@/components/ds/", "@ratel/design-system/"],
        ["@/lib/db/index", "@/lib/platform/db/client"],
        ["@/lib/utils", "@ratel/design-system/cn"],
        ["@/lib/otlp", "@/lib/ingest/otlp"],
      ],
    );
  });

  it("rewrites static, type, re-export, require and dynamic imports", () => {
    const code = [
      'import { a } from "@/lib/otlp/route-handler";',
      "import type { B } from '@/lib/otlp';",
      'export { c } from "@/lib/db/index";',
      'const d = require("@/lib/utils");',
      'const e = await import("@/components/ds/button");',
      'import { Entity } from "@/components/ds/entity";',
      'import { z } from "zod";',
    ].join("\n");
    const { code: out, unmapped } = rewriteSpecifiers(code, rules);
    assert.equal(
      out,
      [
        'import { a } from "@/lib/ingest/otlp/route-handler";',
        "import type { B } from '@/lib/ingest/otlp';",
        'export { c } from "@/lib/platform/db/client";',
        'const d = require("@ratel/design-system/cn");',
        'const e = await import("@ratel/design-system/button");',
        'import { Entity } from "@/components/ds/entity";',
        'import { z } from "zod";',
      ].join("\n"),
    );
    assert.deepEqual(unmapped, []);
  });

  it("reports @/lib specifiers no rule maps, and leaves already-layered ones alone", () => {
    const { code, unmapped } = rewriteSpecifiers('import { x } from "@/lib/legacy/x";\nimport { y } from "@/lib/platform/y";', rules);
    assert.match(code, /@\/lib\/legacy\/x/);
    assert.deepEqual(unmapped, ["@/lib/legacy/x"]);
  });
});

describe("private-strings", () => {
  it("finds matching lines by pattern", () => {
    const hits = findPrivateStrings("ok line\nimport Stripe from 'stripe'\nAcmeCorp dump", [/\bstripe\b/i, /acmecorp/i]);
    assert.deepEqual(hits, [
      { line: 2, pattern: "\\bstripe\\b" },
      { line: 3, pattern: "acmecorp" },
    ]);
  });
});

describe("sync", () => {
  beforeEach(() => {
    source = mkdtempSync(join(tmpdir(), "ratel-sync-src-"));
    repo = mkdtempSync(join(tmpdir(), "ratel-sync-repo-"));
    put(source, "apps/web/lib/otlp/a.ts", 'import { cn } from "@/lib/utils";\nexport const a = 1;\n');
    put(source, "apps/web/lib/otlp/nested/b.ts", 'import { a } from "@/lib/otlp/a";\n');
    put(source, "apps/web/lib/otlp/billing-hook.ts", "export const billing = 1;\n");
    put(source, "apps/web/lib/db/index.ts", "export const db = 'upstream';\n");
    put(source, "apps/web/lib/stripe/client.ts", "export const stripe = 1;\n");
  });
  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const plan = (extra = {}) => planSync({ sourceRoot: source, repoRoot: repo, map: MAP, rewrites: REWRITES, ...extra });

  it("copies mapped folders with rewritten imports, skips excluded paths", () => {
    const { actions, report } = plan();
    applySync(actions, { repoRoot: repo });
    assert.equal(read("apps/web/lib/ingest/otlp/a.ts"), 'import { cn } from "@ratel/design-system/cn";\nexport const a = 1;\n');
    assert.equal(read("apps/web/lib/ingest/otlp/nested/b.ts"), 'import { a } from "@/lib/ingest/otlp/a";\n');
    assert.ok(!existsSync(join(repo, "apps/web/lib/ingest/otlp/billing-hook.ts")));
    assert.ok(!existsSync(join(repo, "apps/web/lib/stripe")));
    assert.deepEqual(report.copied.sort(), ["apps/web/lib/ingest/otlp/a.ts", "apps/web/lib/ingest/otlp/nested/b.ts"]);
  });

  it("bootstraps an owned file once and never overwrites it afterwards", () => {
    const first = plan();
    applySync(first.actions, { repoRoot: repo });
    assert.deepEqual(first.report.ownedBootstrapped, ["apps/web/lib/platform/db/client.ts"]);
    put(repo, "apps/web/lib/platform/db/client.ts", "export const db = 'ours';\n");
    put(source, "apps/web/lib/db/index.ts", "export const db = 'upstream v2';\n");
    const second = plan();
    applySync(second.actions, { repoRoot: repo });
    assert.equal(read("apps/web/lib/platform/db/client.ts"), "export const db = 'ours';\n");
    assert.deepEqual(second.report.ownedKept, ["apps/web/lib/platform/db/client.ts"]);
  });

  it("is idempotent and mirrors deletions", () => {
    applySync(plan().actions, { repoRoot: repo });
    const again = plan();
    assert.deepEqual(again.actions, []);
    rmSync(join(source, "apps/web/lib/otlp/nested"), { recursive: true });
    const third = plan();
    assert.deepEqual(third.report.deleted, ["apps/web/lib/ingest/otlp/nested/b.ts"]);
    applySync(third.actions, { repoRoot: repo });
    assert.ok(!existsSync(join(repo, "apps/web/lib/ingest/otlp/nested/b.ts")));
  });

  it("reports private-string hits and unmapped specifiers", () => {
    put(source, "apps/web/lib/otlp/c.ts", 'import { s } from "@/lib/legacy/s";\nconst key = process.env.STRIPE_SECRET_KEY;\n');
    const { report } = plan({ patterns: [/\bstripe_secret_key\b/i] });
    assert.deepEqual(report.privateHits.map((h) => [h.path, h.line]), [["apps/web/lib/ingest/otlp/c.ts", 2]]);
    assert.deepEqual(report.unmapped, [{ path: "apps/web/lib/ingest/otlp/c.ts", specifier: "@/lib/legacy/s" }]);
  });

  it("limits a run to one destination prefix with `only`", () => {
    const { report } = plan({ only: "apps/web/lib/platform" });
    assert.deepEqual(report.copied, []);
    assert.deepEqual(report.ownedBootstrapped, ["apps/web/lib/platform/db/client.ts"]);
  });
});
