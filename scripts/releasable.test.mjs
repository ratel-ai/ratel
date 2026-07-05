import { test } from "node:test";
import assert from "node:assert/strict";

import { computeReleasable, formatTable } from "./releasable.mjs";

// A two-unit registry is enough to exercise the logic; the real registry lives
// in release-units.mjs and is covered by check-release-tag.test.mjs.
const UNITS = {
  core: { tagPrefix: "core-v", srcPaths: ["src/core"] },
  "sdk-py": { tagPrefix: "sdk-py-v", srcPaths: ["src/sdk/python"] },
};

// Build injectable git fns from a plain description of the repo state.
function fakeGit({ lastTags, commits }) {
  const calls = { countArgs: [] };
  return {
    calls,
    lastTag: (prefix) => (prefix in lastTags ? lastTags[prefix] : null),
    countCommits: (since, paths) => {
      calls.countArgs.push({ since, paths });
      // Key by the tag we count from (or "@" for full history).
      return commits[since ?? "@"] ?? 0;
    },
  };
}

test("a unit with commits since its last tag is releasable, with the count", () => {
  const git = fakeGit({
    lastTags: { "core-v": "core-v0.2.0", "sdk-py-v": "sdk-py-v0.2.0" },
    commits: { "core-v0.2.0": 3, "sdk-py-v0.2.0": 0 },
  });
  const rows = computeReleasable(UNITS, git);

  const core = rows.find((r) => r.unit === "core");
  assert.equal(core.releasable, true);
  assert.equal(core.commits, 3);
  assert.equal(core.lastTag, "core-v0.2.0");
});

test("a unit with zero commits since its last tag is NOT releasable", () => {
  const git = fakeGit({
    lastTags: { "core-v": "core-v0.2.0", "sdk-py-v": "sdk-py-v0.2.0" },
    commits: { "core-v0.2.0": 3, "sdk-py-v0.2.0": 0 },
  });
  const rows = computeReleasable(UNITS, git);

  const py = rows.find((r) => r.unit === "sdk-py");
  assert.equal(py.releasable, false);
  assert.equal(py.commits, 0);
});

test("a never-released unit counts all of history and is releasable", () => {
  const git = fakeGit({
    lastTags: {}, // no tags for any prefix
    commits: { "@": 12 },
  });
  const rows = computeReleasable(UNITS, git);

  const core = rows.find((r) => r.unit === "core");
  assert.equal(core.lastTag, null);
  assert.equal(core.commits, 12);
  assert.equal(core.releasable, true);
});

test("commits are counted from the unit's own tag over its own paths", () => {
  const git = fakeGit({
    lastTags: { "core-v": "core-v0.2.0", "sdk-py-v": "sdk-py-v0.1.9" },
    commits: { "core-v0.2.0": 1, "sdk-py-v0.1.9": 4 },
  });
  computeReleasable(UNITS, git);

  assert.deepEqual(git.calls.countArgs, [
    { since: "core-v0.2.0", paths: ["src/core"] },
    { since: "sdk-py-v0.1.9", paths: ["src/sdk/python"] },
  ]);
});

test("one row per unit, preserving registry order", () => {
  const git = fakeGit({ lastTags: {}, commits: { "@": 1 } });
  const rows = computeReleasable(UNITS, git);
  assert.deepEqual(
    rows.map((r) => r.unit),
    ["core", "sdk-py"],
  );
});

test("formatTable renders every unit and marks releasable ones", () => {
  const rows = [
    { unit: "core", lastTag: "core-v0.2.0", commits: 3, releasable: true },
    { unit: "sdk-py", lastTag: null, commits: 0, releasable: false },
  ];
  const out = formatTable(rows);
  assert.match(out, /core/);
  assert.match(out, /sdk-py/);
  assert.match(out, /core-v0\.2\.0/);
  // never-released unit shows a placeholder rather than the literal "null"
  assert.doesNotMatch(out, /null/);
});
