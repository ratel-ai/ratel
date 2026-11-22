import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countryLabel,
  harnessLabel,
  harnessWithVersion,
  reportedLabel,
  transportLabel,
} from "./labels";

test("harnessLabel names every harness id and the unknown client", () => {
  assert.equal(harnessLabel("claude-code"), "Claude Code");
  assert.equal(harnessLabel("codex"), "Codex");
  assert.equal(harnessLabel("cursor"), "Cursor");
  assert.equal(harnessLabel("opencode"), "OpenCode");
  assert.equal(harnessLabel("vscode"), "VS Code");
  assert.equal(harnessLabel("other"), "Other");
  assert.equal(harnessLabel(null), "Unknown client");
  assert.equal(harnessLabel("zed"), "zed");
});

test("harnessWithVersion adds the version only when there is one", () => {
  assert.equal(harnessWithVersion("claude-code", "2.1.3"), "Claude Code 2.1.3");
  assert.equal(harnessWithVersion("codex", null), "Codex");
  assert.equal(harnessWithVersion(null, null), "Unknown client");
});

test("countryLabel shows the country name with its code", () => {
  assert.equal(countryLabel("IT"), "Italy (IT)");
  assert.equal(countryLabel("us"), "United States (US)");
  assert.equal(countryLabel(null), "Unknown");
  assert.equal(countryLabel("AA"), "AA");
  assert.equal(countryLabel("not-a-code"), "NOT-A-CODE");
});

test("transport and protocol version say Not reported for null", () => {
  assert.equal(transportLabel("stdio"), "stdio");
  assert.equal(transportLabel("http"), "HTTP");
  assert.equal(transportLabel(null), "Not reported");
  assert.equal(reportedLabel("2025-06-18"), "2025-06-18");
  assert.equal(reportedLabel(null), "Not reported");
});
