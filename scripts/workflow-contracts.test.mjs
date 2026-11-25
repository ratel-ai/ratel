import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const imageWorkflow = readFileSync(new URL("../.github/workflows/image.yml", import.meta.url), "utf8");
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

// The demo image exports for 45 s: in the same build it does that while the Next build runs.
test("platform-compose builds the demo image with the app images", () => {
  const body = jobBody(ciWorkflow, "platform-compose");
  const build = body.indexOf("docker compose --profile demo build");
  assert.notEqual(build, -1, "one build for web, worker and demo");
  assert.ok(build < body.indexOf("docker compose up "), "build before the stack starts");
});

// A shard index without a matching total would skip or repeat test files.
test("platform-test runs every shard of one total", () => {
  const body = jobBody(ciWorkflow, "platform-test");
  const shards = body.match(/shard: \[([\d, ]+)\]/)[1].split(",").map(Number);
  assert.deepEqual(shards, [1, 2, 3, 4, 5, 6]);
  assert.match(body, /name: platform-test \(\$\{\{ matrix\.shard \}\}\/6\)/);
  assert.match(body, /TEST_SHARD: \$\{\{ matrix\.shard \}\}\/6\n/);
});

test("platform-compose builds from source through the override", () => {
  assert.match(jobBody(ciWorkflow, "platform-compose"), /COMPOSE_FILE: docker-compose\.yml:docker-compose\.build\.yml/);
});

test("image.yml publishes the app image and the demo image with the same tags", () => {
  const merge = jobBody(imageWorkflow, "merge");
  assert.match(merge, /\{ target: oss, image: ratelai\/ratel \}/);
  assert.match(merge, /\{ target: demo, image: ratelai\/ratel-demo \}/);
  for (const tag of [
    "type=semver,pattern={{version}},value=${{ inputs.version }}",
    "type=semver,pattern={{major}}.{{minor}},value=${{ inputs.version }}",
    "type=raw,value=${{ inputs.tag }},enable=${{ inputs.tag != '' }}",
    "type=edge,branch=main,enable=${{ inputs.version == '' && inputs.tag == '' }}",
  ]) {
    assert.ok(imageWorkflow.includes(tag), tag);
  }
});

// The arm64 Next build takes 11 to 19 minutes under QEMU and about 1.5 on a native runner.
test("image.yml builds each platform of each image on a native runner", () => {
  const build = jobBody(imageWorkflow, "build");
  assert.match(build, /\{ platform: amd64, runner: ubuntu-24\.04 \}/);
  assert.match(build, /\{ platform: arm64, runner: ubuntu-24\.04-arm \}/);
  assert.match(build, /target: \[oss, demo\]/);
  assert.match(build, /runs-on: \$\{\{ matrix\.arch\.runner \}\}/);
  assert.match(build, /platforms: linux\/\$\{\{ matrix\.arch\.platform \}\}/);
  assert.doesNotMatch(imageWorkflow, /setup-qemu-action|cache-(from|to):/);
});

// A tag must never name one platform only: the builds push by digest, and only `merge` tags.
test("image.yml tags an image only after both platforms are pushed", () => {
  assert.match(jobBody(imageWorkflow, "build"), /outputs: .*push-by-digest=true/);
  assert.match(jobBody(imageWorkflow, "merge"), /needs: build\n/);
  assert.match(jobBody(imageWorkflow, "merge"), /imagetools create/);
  assert.match(jobBody(imageWorkflow, "smoke"), /needs: merge\n/);
});

test("image.yml keeps labels, annotations, provenance and SBOM on each platform", () => {
  const build = jobBody(imageWorkflow, "build");
  assert.match(build, /labels: \$\{\{ steps\.meta\.outputs\.labels \}\}/);
  assert.match(build, /annotations: \$\{\{ steps\.meta\.outputs\.annotations \}\}/);
  assert.match(build, /provenance: mode=max\n/);
  assert.match(build, /sbom: true\n/);
});

// release-please.yml calls image.yml on the same push event, so only `inputs` tells that build apart.
test("a release merge cancels the older edge build, and nothing else does", () => {
  const push = { event_name: "push", ref: "refs/heads/main", run_id: 1 };
  const release = { ...push, event: { head_commit: { message: "chore(main): release 0.5.0 (#460)\n\nbody" } } };
  const feature = { ...push, event: { head_commit: { message: "feat: undo chore(main): release 0.5.0 (#461)" } } };
  const tag = { ...release, ref: "refs/tags/v0.5.0" };
  const dispatch = { ...push, event_name: "workflow_dispatch", event: {} };
  for (const [name, github, inputs, expected] of [
    ["release merge", release, {}, { group: "image-refs/heads/main", cancel: true }],
    ["ordinary push", feature, {}, { group: "image-refs/heads/main", cancel: false }],
    ["release build", release, { version: "0.5.0" }, { group: "image-0.5.0", cancel: false }],
    ["tag push", tag, {}, { group: "image-refs/tags/v0.5.0", cancel: false }],
    ["dispatch", dispatch, { tag: "0.0.0-test" }, { group: "image-0.0.0-test", cancel: false }],
  ]) {
    assert.deepEqual(concurrency("image.yml", github, inputs), expected, name);
  }
});

test("no workflow cancels release-please", () => {
  const github = { event_name: "push", ref: "refs/heads/main", event: { head_commit: { message: "chore(main): release 0.5.0" } } };
  assert.deepEqual(concurrency("release-please.yml", github, {}), { group: "release-please", cancel: false });
});
// The merge step is the one place where the tags are made: run it against a stub `docker`.
for (const [name, digests, ok] of [
  ["merges both platforms under every tag", ["a", "b"], true],
  ["refuses to tag one platform only", ["a"], false],
]) {
  test(`image.yml ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-"));
    const hex = digests.map((d) => d.repeat(64));
    for (const d of hex) writeFileSync(join(dir, d), "");
    const script = runBlock(jobBody(imageWorkflow, "merge"), "Create the manifest list");
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", `docker() { echo "docker $*"; }\n${script}`], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, IMAGE: "docker.io/o/i", TAGS: "docker.io/o/i:1.2.3\ndocker.io/o/i:latest\n" },
    });
    rmSync(dir, { recursive: true });
    assert.equal(result.status === 0, ok, result.stderr);
    if (!ok) return assert.doesNotMatch(result.stdout, /create/);
    assert.equal(
      result.stdout.trim().split("\n")[0],
      `docker buildx imagetools create -t docker.io/o/i:1.2.3 -t docker.io/o/i:latest ${hex.map((d) => `docker.io/o/i@sha256:${d}`).join(" ")}`,
    );
  });
}

// Next accepts only letters, digits, - and _ in a deployment id: `0.3.0` fails the build.
test("image.yml makes a valid Next deployment id from any image version", () => {
  assert.match(imageWorkflow, /build-args: NEXT_DEPLOYMENT_ID=\$\{\{ steps\.deployment\.outputs\.id \}\}/);
  const script = imageWorkflow.match(/- id: deployment\n(?: {8}.*\n)*? {8}run: (.*)\n/);
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

// A required check that does not run can count as a pass: only a superseded push may drop the gate.
test("ci-gate runs except on a cancelled push and a draft pull request", () => {
  const condition = jobBody(ciWorkflow, "ci-gate").match(/\n {4}if: >-\n((?: {6}.*\n)+)/);
  assert.ok(condition, "ci-gate must have a condition");
  // Without a status function, GitHub adds success() and a failed need skips the gate.
  assert.match(condition[1], /^\s*always\(\) &&/);
  const runs = new Function("github", "always", "cancelled", `return Boolean(${condition[1]});`);
  for (const [event, draft, cancelled, expected] of [
    ["push", false, false, true],
    ["push", false, true, false],
    ["pull_request", false, false, true],
    ["pull_request", false, true, true],
    ["pull_request", true, false, false],
    ["pull_request", true, true, false],
    ["workflow_dispatch", false, false, true],
    ["workflow_dispatch", false, true, true],
  ]) {
    const github = {
      event_name: event,
      event: event === "pull_request" ? { pull_request: { draft } } : {},
    };
    assert.equal(
      runs(github, () => true, () => cancelled),
      expected,
      `${event} draft=${draft} cancelled=${cancelled}`,
    );
  }
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

// Evaluates the workflow-level concurrency. The expressions it accepts are also valid JavaScript,
// once a missing property reads as empty.
function concurrency(file, github, inputs) {
  const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
  const block = workflow.match(/^concurrency:\n((?: {2}.*\n)+)/m);
  assert.ok(block, `${file} must set concurrency`);
  const startsWith = (text, prefix) => (text ?? "").toLowerCase().startsWith(prefix.toLowerCase());
  const evaluate = (expression) =>
    new Function("github", "inputs", "startsWith", `return ${expression.replace(/(\w)\.(?=[a-z])/g, "$1?.")}`)(
      github,
      inputs,
      startsWith,
    );
  const value = (key) => {
    const raw = block[1].match(new RegExp(`^ {2}${key}: (.*)`, "m"));
    assert.ok(raw, `${file} must set ${key}`);
    assert.ok(raw[1].startsWith('"') || !raw[1].includes(": "), `${key}: YAML rejects ": " in a plain value`);
    return raw[1].replace(/^"|"$/g, "").replace(/\$\{\{(.*?)\}\}/g, (_, expression) => String(evaluate(expression.trim())));
  };
  return { group: value("group"), cancel: value("cancel-in-progress") === "true" };
}

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

function runBlock(job, step) {
  const block = job.match(new RegExp(`- name: ${step}\\n(?:(?! {6}- ).*\\n)*? {8}run: \\|\\n((?: {10}.*\\n|\\n)+)`));
  assert.ok(block, `missing step: ${step}`);
  return block[1].replace(/^ {10}/gm, "");
}

function jobBody(workflow, job) {
  const start = workflow.indexOf(`\n  ${job}:`);
  assert.notEqual(start, -1, `missing ${job} job`);

  const rest = workflow.slice(start + 1);
  const nextJob = rest.slice(1).search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
}
