import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { findPrivateStrings, hashToken, scanDir } from "./private-strings.mjs";
import { absolutizeRelative, buildRules, partitionImports, renameIdentifiers, rewriteSource, rewriteSpecifiers } from "./rewrite-imports.mjs";
import { applySync, copyIncludes, planSync } from "./sync.mjs";

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

describe("partitions and identifiers", () => {
  const partitions = {
    "@/lib/db/schema": {
      default: "@/lib/platform/db/tables",
      symbols: { users: "@/lib/platform/identity/schema", traceEvents: "@/lib/ingest/schema" },
    },
  };

  it("splits a named import per symbol and keeps type modifiers and aliases", () => {
    const code = 'import { users, type Project, traceEvents as te } from "@/lib/db/schema";\nconst x = 1;';
    const { code: out, unmapped } = partitionImports(code, partitions);
    assert.equal(
      out,
      [
        'import { users } from "@/lib/platform/identity/schema";',
        'import { type Project } from "@/lib/platform/db/tables";',
        'import { traceEvents as te } from "@/lib/ingest/schema";',
        "const x = 1;",
      ].join("\n"),
    );
    assert.deepEqual(unmapped, ["@/lib/db/schema#Project"]);
  });

  it("maps type-only, re-export and namespace forms to the partition's default", () => {
    const code = ['import type { Organization } from "@/lib/db/schema";', 'export { users } from "@/lib/db/schema";', 'import * as schema from "@/lib/db/schema";'].join("\n");
    const { code: out } = partitionImports(code, partitions);
    assert.equal(
      out,
      [
        'import type { Organization } from "@/lib/platform/db/tables";',
        'export { users } from "@/lib/platform/identity/schema";',
        'import * as schema from "@/lib/platform/db/tables";',
      ].join("\n"),
    );
  });

  it("imports a partitioned member of a namespace from its own module", () => {
    const code = ['import * as schema from "@/lib/db/schema";', "db.select().from(schema.traceEvents).where(schema.projects.id);", "drizzle(client, { schema });"].join("\n");
    const { code: out, unmapped } = partitionImports(code, partitions);
    assert.equal(
      out,
      [
        'import * as schema from "@/lib/platform/db/tables";',
        'import { traceEvents } from "@/lib/ingest/schema";',
        "db.select().from(traceEvents).where(schema.projects.id);",
        "drizzle(client, { schema });",
      ].join("\n"),
    );
    assert.deepEqual(unmapped, []);
  });

  it("keeps relative imports inside one moved folder and absolutizes the ones that cross entries", () => {
    const entries = [
      { from: "apps/web/lib/otlp", to: "apps/web/lib/ingest/otlp", mode: "copy" },
      { from: "apps/web/lib/db/index.ts", to: "apps/web/lib/platform/db/client.ts", mode: "owned" },
      { from: "apps/web/lib/db/statement-timeout.ts", to: "apps/web/lib/platform/db/statement-timeout.ts", mode: "copy" },
    ];
    const inFolder = absolutizeRelative('import { b } from "./nested/b";\nimport { db } from "../db/index";', "apps/web/lib/otlp/a.ts", entries);
    assert.equal(inFolder, 'import { b } from "./nested/b";\nimport { db } from "@/lib/db";');
    const fileEntry = absolutizeRelative('import { getDb } from "./index";\nimport type { X } from "./schema";', "apps/web/lib/db/statement-timeout.ts", entries);
    assert.equal(fileEntry, 'import { getDb } from "@/lib/db";\nimport type { X } from "@/lib/db/schema";');
    assert.equal(absolutizeRelative('import x from "./y";', "scripts/x.ts", entries), 'import x from "./y";');
    const moved = [...entries, { from: "apps/web/lib/otlp/view.ts", to: "apps/web/lib/console/view.ts", mode: "copy" }];
    assert.equal(
      absolutizeRelative('import { v } from "./vocabulary";', "apps/web/lib/otlp/view.ts", moved),
      'import { v } from "@/lib/otlp/vocabulary";',
    );
  });

  it("renames identifiers on word boundaries only", () => {
    const out = renameIdentifiers("user.clerkId; clerkIdentity; insert into users (clerk_id)", { clerkId: "externalId", clerk_id: "external_id" });
    assert.equal(out, "user.externalId; clerkIdentity; insert into users (external_id)");
  });

  it("runs partitions, specifiers and identifiers in order", () => {
    const rules = buildRules(MAP, REWRITES);
    const { code: out, unmapped } = rewriteSource(
      'import { users } from "@/lib/db/schema";\nimport { a } from "@/lib/otlp/a";\nconst id = user.clerkId;',
      { rules, partitions, identifiers: { clerkId: "externalId" } },
    );
    assert.equal(out, 'import { users } from "@/lib/platform/identity/schema";\nimport { a } from "@/lib/ingest/otlp/a";\nconst id = user.externalId;');
    assert.deepEqual(unmapped, []);
  });
});

describe("private-strings", () => {
  it("matches a hashed word by whole token, case-insensitively, in prose and in paths", () => {
    const entry = { hash: hashToken("AcmeCorp") };
    const hits = findPrivateStrings("fine\napps/web/lib/seed/acmecorp-replay.ts\nACMECORP's data\nacmecorporation", [entry]);
    assert.deepEqual(hits.map((h) => h.line), [2, 3]);
    assert.match(hits[0].pattern, /^sha256:[0-9a-f]{12}$/);
  });

  it("a hash entry never matches its own line in the list", () => {
    const entry = { hash: hashToken("acmecorp") };
    assert.deepEqual(findPrivateStrings(`sha256:${entry.hash}`, [entry]), []);
  });

  it("regex entries guard only the code root; hashed words guard the whole tree", () => {
    const root = mkdtempSync(join(tmpdir(), "ratel-private-"));
    try {
      put(root, "apps/web/lib/x.ts", "import Stripe from 'stripe';\n");
      put(root, "docs/adr/y.md", "Stripe stays in Cloud. AcmeCorp's data too.\n");
      put(root, "node_modules/z/index.js", "stripe acmecorp\n");
      const hits = scanDir(root, [/\bstripe\b/i, { hash: hashToken("acmecorp") }], { codeRoot: join(root, "apps/web") });
      assert.deepEqual(hits.map((h) => [h.path, h.line, h.pattern.startsWith("sha256:")]).sort(), [
        ["apps/web/lib/x.ts", 1, false],
        ["docs/adr/y.md", 1, true],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it("lands a file with its own entry only there, not in its copied folder", () => {
    const map = { entries: [...MAP.entries, { from: "apps/web/lib/otlp/nested/b.ts", to: "apps/web/lib/console/b.ts", mode: "copy" }] };
    const { actions, report } = plan({ map });
    applySync(actions, { repoRoot: repo });
    assert.ok(existsSync(join(repo, "apps/web/lib/console/b.ts")));
    assert.ok(!existsSync(join(repo, "apps/web/lib/ingest/otlp/nested/b.ts")));
    assert.deepEqual(report.copied.sort(), ["apps/web/lib/console/b.ts", "apps/web/lib/ingest/otlp/a.ts"]);
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

  it("never lands an upstream path that names confidential data, and never prints it", () => {
    put(source, "apps/web/lib/otlp/acmecorp-replay.ts", "export const replay = 1;\n");
    const { actions, report } = plan({ patterns: [{ hash: hashToken("acmecorp") }] });
    assert.equal(report.privatePathsSkipped, 1);
    assert.deepEqual(report.privateHits, []);
    assert.ok(!JSON.stringify(actions).includes("acmecorp"));
  });

  it("limits a run to one destination prefix with `only`", () => {
    const { report } = plan({ only: "apps/web/lib/platform" });
    assert.deepEqual(report.copied, []);
    assert.deepEqual(report.ownedBootstrapped, ["apps/web/lib/platform/db/client.ts"]);
  });
});

describe("biome copy override", () => {
  it("lists copy entries, a folder as a glob followed by the owned files inside it", () => {
    repo = mkdtempSync(join(tmpdir(), "ratel-sync-repo-"));
    put(repo, "apps/web/lib/ingest/otlp/a.ts", "");
    const map = {
      entries: [
        ...MAP.entries,
        { from: "apps/web/lib/otlp/own.ts", to: "apps/web/lib/ingest/otlp/own.ts", mode: "owned" },
        { from: "apps/web/lib/seed/[id].ts", to: "apps/web/lib/console/seed/[id].ts", mode: "copy" },
      ],
    };
    assert.deepEqual(copyIncludes(map, repo), [
      "apps/web/lib/ingest/otlp/**",
      "!apps/web/lib/ingest/otlp/own.ts",
      "apps/web/lib/console/seed/\\[id\\].ts",
    ]);
    rmSync(repo, { recursive: true, force: true });
  });

  it("matches map.json in the repository's biome.json", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const map = JSON.parse(readFileSync(join(root, "scripts/platform-sync/map.json"), "utf8"));
    const biome = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
    const override = biome.overrides.find((o) => o.linter?.rules?.suspicious?.useIterableCallbackReturn === "off");
    assert.deepEqual(override.includes, copyIncludes(map, root));
  });
});
