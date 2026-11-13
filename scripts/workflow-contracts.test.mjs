import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const publishRc = readFileSync(new URL("./publish-rc.sh", import.meta.url), "utf8");
const verifyInstallWorkflow = readFileSync(
  new URL("../.github/workflows/verify-install.yml", import.meta.url),
  "utf8",
);

test("main push path filtering checks out the repository first", () => {
  const changesJob = jobBody(ciWorkflow, "changes");
  const checkout = changesJob.indexOf("uses: actions/checkout@");
  const pathsFilter = changesJob.indexOf("uses: dorny/paths-filter@");

  assert.notEqual(checkout, -1, "changes job must check out the repository");
  assert.ok(checkout < pathsFilter, "checkout must run before paths-filter");
});

for (const job of ["verify-vercel-ai-sdk", "verify-mastra"]) {
  test(`${job} co-installs @ratel-ai/sdk@latest without interpolating a specific SDK version`, () => {
    const body = jobBody(verifyInstallWorkflow, job);

    assert.match(body, /"@ratel-ai\/sdk@latest"/);
    assert.doesNotMatch(body, /"@ratel-ai\/sdk@\$\{\{/);
  });
}

for (const job of ["publish-mastra", "publish-vercel-ai-sdk"]) {
  test(`${job} pins the SDK peer via pin-adapter-sdk-peer.mjs, not a caret of SDK_VER`, () => {
    const body = jobBody(releaseWorkflow, job);
    assert.match(body, /node scripts\/pin-adapter-sdk-peer\.mjs/);
    assert.doesNotMatch(body, /const v='\^'\+process\.env\.SDK_VER/);
    assert.doesNotMatch(body, /npm view "@ratel-ai\/sdk@\^\$\{sdk_ver\}"/);
  });
}

test("publish-vercel-ai-sdk pins telemetry with the release caret on runtime and dev", () => {
  const body = jobBody(releaseWorkflow, "publish-vercel-ai-sdk");
  assert.ok(
    body.includes(
      "const v='^'+process.env.TELE_VER; p.dependencies['@ratel-ai/telemetry']=v; p.devDependencies['@ratel-ai/telemetry']=v",
    ),
  );
  assert.ok(body.includes('npm view "@ratel-ai/telemetry@^${tele_ver}" version'));
});

test("publish-rc.sh restores adapter manifests with a git checkout EXIT trap", () => {
  assert.match(publishRc, /trap .*git .*checkout/);
});

// workflow-contracts runs in the changes job on every ready PR, so a release.yml-only
// or verify-install.yml-only edit still exercises these assertions without forcing sdk.
test("changes job runs workflow-contracts and ci-filters tests", () => {
  const body = jobBody(ciWorkflow, "changes");
  assert.match(body, /scripts\/workflow-contracts\.test\.mjs/);
  assert.match(body, /scripts\/ci-filters\.test\.mjs/);
});

// The rankers plugin (ADR-0028) peers on the SDK, so its npm loader must publish
// after the SDK's and pin its own platform packages, not the SDK's.
test("publish-rankers-ts injects the plugin's own platform packages", () => {
  const body = jobBody(releaseWorkflow, "publish-rankers-ts");
  assert.match(body, /node scripts\/inject-sdk-optional-deps\.mjs src\/rankers\/ts/);
  assert.match(body, /npm publish/);
});

// The SDK's sources import its gitignored native loader (`../native/index.cjs`),
// which only `build:native` generates, so a bare `build:ts` of the SDK fails on a
// clean checkout. One script builds what the rankers-ts publish packs; the release
// job, the bootstrap and a CI job all run it, so the publish build is exercised on
// every PR rather than first on a release tag (the release env only admits tags).
const buildRankersTs = readFileSync(new URL("./build-rankers-ts.sh", import.meta.url), "utf8");

test("build-rankers-ts.sh builds the SDK natively, then only the plugin's tsc", () => {
  assert.match(buildRankersTs, /pnpm --filter "@ratel-ai\/sdk\.\.\." run build\n/);
  assert.match(buildRankersTs, /pnpm --filter @ratel-ai\/rankers-plugin run build:ts\n/);
  assert.doesNotMatch(buildRankersTs, /--filter @ratel-ai\/sdk run build:ts/);
});

test("publish-rankers-ts builds with build-rankers-ts.sh and has a Rust toolchain", () => {
  const body = jobBody(releaseWorkflow, "publish-rankers-ts");
  assert.match(body, /uses: dtolnay\/rust-toolchain@/);
  assert.match(body, /run: scripts\/build-rankers-ts\.sh/);
});

test("publish-rc.sh builds the rankers-ts bootstrap with build-rankers-ts.sh", () => {
  const fn = publishRc.slice(publishRc.indexOf("publish_rankers_ts()"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /scripts\/build-rankers-ts\.sh/);
  assert.doesNotMatch(body, /--filter @ratel-ai\/sdk run build:ts/);
});

test("ci runs build-rankers-ts.sh on a clean runner, gated by ci-gate", () => {
  const body = jobBody(ciWorkflow, "rankers-ts-publish-build");
  assert.match(body, /needs\.changes\.outputs\.rankers_ts == 'true'/);
  assert.match(body, /run: scripts\/build-rankers-ts\.sh/);
  assert.doesNotMatch(body, /pnpm -r build/);
  assert.match(jobBody(ciWorkflow, "ci-gate"), /rankers-ts-publish-build/);
});

test("release.yml triggers on the rankers tags and the GitHub release waits for them", () => {
  for (const prefix of ["rankers-ts-v", "rankers-py-v"]) {
    assert.ok(releaseWorkflow.includes(`- '${prefix}*'`), `missing ${prefix}* trigger`);
  }
  const release = jobBody(releaseWorkflow, "github-release");
  for (const job of ["publish-rankers-ts", "publish-rankers-py"]) {
    assert.ok(release.includes(job), `github-release must wait for ${job}`);
  }
});

test("classifier selects rust, sdk, and python for rankers paths", async () => {
  const { classify } = await import("./ci-filters.mjs");
  assert.equal(classify(["src/rankers/core/src/lib.rs"]).rust, true);
  assert.equal(classify(["src/rankers/ts/src/index.ts"]).sdk, true);
  assert.equal(classify(["src/rankers/python/src/lib.rs"]).python, true);
});

test("ci-gate needs the rankers python job", () => {
  assert.ok(jobBody(ciWorkflow, "ci-gate").includes("rankers-python"));
});

function jobBody(workflow, job) {
  const start = workflow.indexOf(`\n  ${job}:`);
  assert.notEqual(start, -1, `missing ${job} job`);

  const rest = workflow.slice(start + 1);
  const nextJob = rest.slice(1).search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
}

// npm only admits a prerelease when the range names one of the same version, so
// a range like ">=0.13.0-rc.12 <1.0.0" rejects 0.14.0-rc.1. The plugin peers on
// "*" (npm treats it as always satisfied) and keeps its floor in ratel.sdkFloor,
// which the release gate and the install smoke test read (ADR-0028).
const rankersTsPkg = JSON.parse(
  readFileSync(new URL("../src/rankers/ts/package.json", import.meta.url), "utf8"),
);

test("the rankers plugin peers on any SDK and records its floor in ratel.sdkFloor", () => {
  assert.equal(rankersTsPkg.peerDependencies["@ratel-ai/sdk"], "*");
  assert.match(rankersTsPkg.ratel?.sdkFloor ?? "", /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
});

test("publish-rankers-ts checks ratel.sdkFloor is on npm, not the peer range", () => {
  const body = jobBody(releaseWorkflow, "publish-rankers-ts");
  assert.match(body, /ratel\.sdkFloor/);
  assert.doesNotMatch(body, /peerDependencies\['@ratel-ai\/sdk'\]/);
});

test("verify-rankers-ts co-installs the newest SDK at or above the floor, prereleases included", () => {
  const body = jobBody(verifyInstallWorkflow, "verify-rankers-ts");
  assert.doesNotMatch(body, /"@ratel-ai\/sdk@latest"/);
  assert.match(body, /ratel\.sdkFloor/);
  assert.match(body, /--include-prerelease/);
});

// The co-install above picks the SDK itself, so it never ran the command users
// are told to run. This step does, read from the README, and checks the SDK it
// lands on is at or above the floor.
test("verify-rankers-ts runs the README's install command and checks the floor", () => {
  const body = jobBody(verifyInstallWorkflow, "verify-rankers-ts");
  assert.match(body, /src\/rankers\/ts\/README\.md/);
  assert.match(body, /require\('@ratel-ai\/sdk\/package\.json'\)\.version/);
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
