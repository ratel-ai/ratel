import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("main push path filtering checks out the repository first", () => {
  const changesJob = jobBody(ciWorkflow, "changes");
  const checkout = changesJob.indexOf("uses: actions/checkout@");
  const pathsFilter = changesJob.indexOf("uses: dorny/paths-filter@");

  assert.notEqual(checkout, -1, "changes job must check out the repository");
  assert.ok(checkout < pathsFilter, "checkout must run before paths-filter");
});

// workflow-contracts runs in the changes job on every ready PR, so a workflow-only edit
// still exercises these assertions.
test("changes job runs workflow-contracts and ci-filters tests", () => {
  const body = jobBody(ciWorkflow, "changes");
  assert.match(body, /scripts\/workflow-contracts\.test\.mjs/);
  assert.match(body, /scripts\/ci-filters\.test\.mjs/);
});

test("dependency-scan runs on lockfile changes and gates ci-gate", () => {
  const body = jobBody(ciWorkflow, "dependency-scan");
  assert.match(body, /needs\.changes\.outputs\.lockfiles == 'true'/);
  assert.match(body, /--ignore-unfixed/);
  assert.ok(jobBody(ciWorkflow, "ci-gate").includes("dependency-scan"));
});

test("platform-compose scans the image it built, pinned by digest", () => {
  const body = jobBody(ciWorkflow, "platform-compose");
  assert.match(body, /image --scanners vuln/);
  assert.match(body, /aquasec\/trivy:[\d.]+@sha256:[0-9a-f]{64}/);
});

// ci-gate is the only required check, so a job missing from its `needs` cannot block a merge.
test("ci-gate needs every other job", () => {
  const jobs = [...ciWorkflow.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)]
    .map((m) => m[1])
    .filter((job) => jobBody(ciWorkflow, job).includes("\n    runs-on:") && job !== "ci-gate");
  const needs = jobBody(ciWorkflow, "ci-gate").match(/needs: \[([^\]]*)\]/);
  assert.ok(needs, "ci-gate must list its needs");
  const listed = needs[1].split(",").map((s) => s.trim());
  assert.deepEqual([...listed].sort(), [...jobs].sort());
});

// The SDKs and their release workflows moved to ratel-ai/ratel-sdk.
test("ci.yml builds no SDK artifact", () => {
  assert.doesNotMatch(ciWorkflow, /dtolnay\/rust-toolchain|cargo |maturin|src\/sdk|e2e\//);
});

function jobBody(workflow, job) {
  const start = workflow.indexOf(`\n  ${job}:`);
  assert.notEqual(start, -1, `missing ${job} job`);

  const rest = workflow.slice(start + 1);
  const nextJob = rest.slice(1).search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
}
