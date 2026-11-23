import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const prTitleWorkflow = readFileSync(
  new URL("../.github/workflows/pr-title.yml", import.meta.url),
  "utf8",
);

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

test("platform-compose builds from source through the override", () => {
  assert.match(jobBody(ciWorkflow, "platform-compose"), /COMPOSE_FILE: docker-compose\.yml:docker-compose\.build\.yml/);
});

test("image.yml publishes the app image and the demo image with the same tags", () => {
  const image = readFileSync(new URL("../.github/workflows/image.yml", import.meta.url), "utf8");
  assert.match(image, /\{ target: oss, image: ratelai\/ratel, /);
  assert.match(image, /\{ target: demo, image: ratelai\/ratel-demo, /);
});

// Next accepts only letters, digits, - and _ in a deployment id: `0.3.0` fails the build.
test("image.yml makes a valid Next deployment id from any image version", () => {
  const image = readFileSync(new URL("../.github/workflows/image.yml", import.meta.url), "utf8");
  assert.match(image, /build-args: NEXT_DEPLOYMENT_ID=\$\{\{ steps\.deployment\.outputs\.id \}\}/);
  const script = image.match(/- id: deployment\n(?: {8}.*\n)*? {8}run: (.*)\n/);
  assert.ok(script, "image.yml must have a deployment step");
  for (const [version, id] of [["0.3.1", "0-3-1"], ["1.0.0-rc.1", "1-0-0-rc-1"], ["edge", "edge"]]) {
    const result = spawnSync("bash", ["-c", script[1].replace('>> "$GITHUB_OUTPUT"', "")], {
      encoding: "utf8",
      env: { ...process.env, VERSION: version },
    });
    assert.equal(result.stdout.trim(), `id=${id}`);
  }
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

test("pr-title accepts conventional titles", () => {
  for (const title of [
    "feat: add evals",
    "feat(RP-178): check PR titles",
    "fix(api)!: drop v0",
    "perf: cache tokens",
    "refactor!: move web",
    "docs(adr): cut 33 ADRs",
    "test: cover reaper",
    "build: pin node",
    "ci: check titles",
    'revert: "feat: add evals"',
    "chore(deps): bump the npm-minor-patch group across 1 directory with 42 updates",
    "chore(ci): bump actions/checkout from 4 to 7",
    "chore(main): release 0.1.0",
    "chore(deps): update pkg requirement from <1.42,>=1.41.0 to >=1.41.0,<1.46 in /src",
    "fix: $(exit 1) `exit 1` '; exit 1",
  ]) {
    assert.equal(prTitleStatus(title), 0, title);
  }
});

test("pr-title rejects other titles", () => {
  for (const title of [
    "",
    "RP-169 Core flags by semantic key",
    "RP-178: feat: check PR titles",
    "Feat: add evals",
    "feature: add evals",
    "feat add evals",
    "feat:add evals",
    "feat:  ",
    "feat(): add evals",
    "feat(api: add evals",
    "Merge pull request #13 from ratel-ai/branch",
    'Revert "feat: add evals"',
    "$(exit 0)",
  ]) {
    assert.equal(prTitleStatus(title), 1, title);
  }
});

test("pr-title runs no pull-request code and needs no permission", () => {
  assert.match(prTitleWorkflow, /^permissions: \{\}$/m);
  assert.doesNotMatch(prTitleWorkflow, /pull_request_target|uses:/);
  assert.doesNotMatch(prTitleScript(), /\$\{\{/);
  assert.match(prTitleWorkflow, /types: \[opened, edited, synchronize, reopened, ready_for_review\]/);
  assert.match(jobBody(prTitleWorkflow, "pr-title"), /name: pr-title\n/);
});

function prTitleStatus(title) {
  const { status } = spawnSync("bash", ["-eo", "pipefail", "-c", prTitleScript()], {
    env: { PATH: process.env.PATH, PR_TITLE: title },
  });
  return status;
}

function prTitleScript() {
  const run = prTitleWorkflow.match(/^ +run: \|\n((?: {10}.*\n|\n)+)/m);
  assert.ok(run, "pr-title must have one run script");
  return run[1].replace(/^ {10}/gm, "");
}

function jobBody(workflow, job) {
  const start = workflow.indexOf(`\n  ${job}:`);
  assert.notEqual(start, -1, `missing ${job} job`);

  const rest = workflow.slice(start + 1);
  const nextJob = rest.slice(1).search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
}
