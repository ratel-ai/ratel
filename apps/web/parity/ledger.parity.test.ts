import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LEDGER } from "./ledger";
import { SOURCE_PROBES } from "./source-probes";

// The ledger keeps the harness honest: exactly the audit's 28 items, and a test for each.

const PARITY_DIR = dirname(fileURLToPath(import.meta.url));
const GOLDEN = [
  "navigation",
  "analysis-sections",
  "redirects",
  "fixes",
  "savings",
  "drain",
  "snippets",
  "seed-plan",
  "self-telemetry",
  "imported-source",
  "schema-facts",
  "new-project",
  "source-facts",
];

/** The items the parity tests name: `parity(<n>, …)` calls, and the source probes' items. */
function testedItems(): Set<number> {
  const items = new Set<number>(Object.values(SOURCE_PROBES).map((probe) => probe.item));
  for (const file of readdirSync(PARITY_DIR).filter((name) => name.endsWith(".parity.test.ts"))) {
    for (const match of readFileSync(join(PARITY_DIR, file), "utf8").matchAll(
      /\bparity\(\s*(\d+)\s*,/g,
    )) {
      items.add(Number(match[1]));
    }
  }
  return items;
}

test("the ledger has exactly the audit's 28 items", () => {
  assert.deepEqual(
    LEDGER.map((entry) => entry.item),
    Array.from({ length: 28 }, (_unused, index) => index + 1),
  );
  for (const entry of LEDGER) {
    assert.ok(
      entry.status === "open" || entry.status === "fixed",
      `item ${entry.item} has status ${entry.status}`,
    );
  }
});

test("every ledger item has a parity test, so a fixed item is always gated", () => {
  const tested = testedItems();
  assert.deepEqual(
    LEDGER.filter((entry) => !tested.has(entry.item)).map((entry) => entry.item),
    [],
  );
});

test("every captured subject is in the tree, stamped with one Cloud commit", () => {
  const commits = new Set<string>();
  for (const subject of GOLDEN) {
    const path = join(PARITY_DIR, "golden", `${subject}.json`);
    assert.ok(existsSync(path), `golden/${subject}.json is missing: run pnpm parity:capture`);
    commits.add((JSON.parse(readFileSync(path, "utf8")) as { cloudCommit: string }).cloudCommit);
  }
  assert.equal(commits.size, 1, "the captured files come from more than one Cloud commit");
  const source = JSON.parse(
    readFileSync(
      join(PARITY_DIR, "..", "..", "..", "scripts", "platform-sync", "source.json"),
      "utf8",
    ),
  ) as { commit: string };
  assert.deepEqual(
    [...commits],
    [source.commit],
    "the captured files are not from the synced Cloud commit",
  );
});
