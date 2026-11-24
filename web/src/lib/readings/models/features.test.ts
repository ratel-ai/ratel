import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_LABEL_MODEL } from "@/lib/readings/model-defaults";
import { FEATURES, type FeatureRow, featureRow, featureVariable, isFeature } from "./features";

const LIB = join(import.meta.dirname, "..", "..");

/** Every non-test source file under `lib/`. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...sources(path));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$|test-helpers|fixture/.test(entry.name)
    ) {
      out.push(path);
    }
  }
  return out;
}

/** The ways a call site names its feature: a `feature` field, or a `*_FEATURE` / `*Feature` constant or default. */
const FEATURE_LITERAL = /(?:\bfeature|FEATURE|Feature)\w*\s*[:=]\s*"([a-z][a-z0-9_]*)"/g;
/** A feature handed over as an argument, which the patterns above cannot see. Add one here when you add such a call. */
const PASSED_AS_ARGUMENT = ["topics_sentiment"];
/** The eval gate names its features in a union type, in this one file. */
const EVAL_GATE_UNION = "views/eval-gate/models.ts";
const EVAL_GATE_LITERAL = /"(eval_gate_[a-z_]+)"/g;
/** The kit's own files say `kind: "text"`, which is not a call. */
const KIT = "readings/models/";

test("every feature a model call names is in the feature table", () => {
  const named = new Map<string, string>();
  for (const file of sources(LIB)) {
    const name = file.slice(LIB.length + 1);
    if (name.startsWith(KIT)) continue;
    const text = readFileSync(file, "utf8");
    const patterns =
      name === EVAL_GATE_UNION ? [FEATURE_LITERAL, EVAL_GATE_LITERAL] : [FEATURE_LITERAL];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) named.set(match[1], name);
    }
  }
  for (const id of PASSED_AS_ARGUMENT) named.set(id, "(passed as an argument)");
  assert.ok(named.size >= 14, `found only ${named.size} feature names; the scan is broken`);
  const missing = [...named].filter(([id]) => !isFeature(id));
  assert.deepEqual(
    missing,
    [],
    "add each of these to lib/readings/models/features.ts (see its README)",
  );
});

test("feature ids are unique and snake_case", () => {
  const ids = FEATURES.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9_]*$/);
});

test("a text or chat feature has a tier and a Claude default; a decision feature has neither", () => {
  for (const row of FEATURES as readonly FeatureRow[]) {
    if (row.kind === "decision") {
      assert.equal(row.tier, undefined, row.id);
      assert.equal(row.claudeDefault, undefined, row.id);
    } else {
      assert.ok(row.tier, row.id);
      assert.match(row.claudeDefault ?? "", /^claude-/, row.id);
    }
  }
});

test("the Claude defaults are the ones the call sites use today", () => {
  assert.equal(featureRow("workflow_label").claudeDefault, DEFAULT_LABEL_MODEL);
  assert.equal(featureRow("intent_names").claudeDefault, DEFAULT_LABEL_MODEL);
  assert.equal(featureRow("topics_names").claudeDefault, DEFAULT_LABEL_MODEL);
  assert.equal(featureRow("match_quality_analyst").claudeDefault, "claude-opus-5-5");
  assert.equal(featureRow("eval_gate_fix_draft").claudeDefault, "claude-sonnet-5-5");
  assert.equal(featureRow("eval_gate_replay").claudeDefault, "claude-opus-5-5");
  assert.equal(featureRow("eval_gate_judge").claudeDefault, "claude-haiku-5-5");
});

test("an unknown feature is refused by name", () => {
  assert.equal(isFeature("nope"), false);
  assert.throws(() => featureRow("nope" as never), /nope/);
});

test("the sample environment lists every feature's own model variable", () => {
  const sample = readFileSync(join(LIB, "..", "..", ".env.example"), "utf8");
  for (const row of FEATURES.filter((feature) => feature.kind !== "decision"))
    assert.match(sample, new RegExp(`^#   ${featureVariable(row.id)} `, "m"), row.id);
});
