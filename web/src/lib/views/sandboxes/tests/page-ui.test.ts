import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { SandboxView } from "@/components/console/sandboxes/SandboxView";
import { resolveConfig } from "@/config";
import { consoleNav, flattenNav } from "@/lib/console/navigation";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";
import { sandboxOrganizationIds } from "../gate";
import type { RunRow, SandboxPageModel, VersionRow } from "../page-model";

const COMMIT = "b1c2d3e4f5a6b1c2d3e4f5a6b1c2d3e4f5a6b1c2";
const NOW = "2026-11-24T10:00:00.000Z";

const version = (over: Partial<VersionRow> = {}): VersionRow => ({
  id: "66666666-6666-4666-8666-666666666666",
  name: "support-demo",
  status: "ready",
  reason: null,
  commit: COMMIT,
  dirty: false,
  createdAt: NOW,
  buildLog: "> install command 1 (npm install)\n",
  smoke: null,
  ...over,
});
const run: RunRow = {
  runId: "77777777-7777-4777-8777-777777777777",
  versionId: version().id,
  status: "completed",
  reason: null,
  errorCode: null,
  logs: "",
  input: { message: "refund it" },
  params: {},
  result: {
    v: 1,
    runId: "77777777-7777-4777-8777-777777777777",
    status: "completed",
    output: "It is refunded.",
    toolCalls: [
      { name: "lookup_order", arguments: { id: "7" }, result: { total: 12 }, source: "real" },
      { name: "refund_order", arguments: { id: "7" }, result: { ok: true }, source: "fake" },
    ],
    usage: { durationMs: 10 },
    traceId: "c".repeat(32),
  },
  traceId: "c".repeat(32),
  createdAt: NOW,
  startedAt: NOW,
  finishedAt: NOW,
};
const model = (over: Partial<SandboxPageModel> = {}): SandboxPageModel => ({
  projectId: PROJECT_ID,
  configured: true,
  canEdit: true,
  versions: [],
  secrets: [],
  runs: [],
  ...over,
});
const html = (over: Partial<SandboxPageModel> = {}) =>
  render(
    createElement(SandboxView, { model: model(over), ratelUrl: "https://ratel.example", now: NOW }),
  );
const STATES: Record<string, Partial<SandboxPageModel>> = {
  empty: {},
  "not configured": { configured: false },
  full: {
    versions: [
      version(),
      version({ status: "failed", reason: "install command 1 failed." }),
      version({ status: "preparing", commit: null }),
      version({
        status: "failed",
        reason: "GET /ratel/health did not answer 200 in 60 s.",
        smoke: {
          ok: false,
          error: { code: "no_health", message: "GET /ratel/health did not answer 200 in 60 s." },
          durationMs: 0,
          logs: "agent booted\n",
        },
      }),
    ],
    secrets: [
      { name: "ANTHROPIC_API_KEY", updatedAt: null, declared: true },
      { name: "OLD_KEY", updatedAt: NOW, declared: false },
    ],
    runs: [run],
  },
  "no result": {
    versions: [version()],
    runs: [
      {
        ...run,
        status: "timed_out",
        result: null,
        traceId: null,
        reason: "The run had no result before its timeout.",
      },
    ],
  },
};

test("a version shows its state, its commit, its smoke check and its log", () => {
  const text = visibleText(html(STATES.full));
  for (const words of [
    "support-demo",
    "Ready",
    "Failed",
    COMMIT.slice(0, 12),
    "install command 1",
    "Preparing",
    "no_health",
    "Smoke check logs",
  ]) {
    assert.ok(text.includes(words), words);
  }
});

test("run once shows the output, the tool calls with their source and a link to the trace", () => {
  const page = html(STATES.full);
  const text = visibleText(page);
  for (const words of [
    "It is refunded.",
    "lookup_order",
    "Ran for real",
    "refund_order",
    "Faked",
  ]) {
    assert.ok(text.includes(words), words);
  }
  assert.ok(page.includes(`href="/project/${PROJECT_ID}/traces/${"c".repeat(32)}"`));
});

test("a declared secret with no value is marked missing", () => {
  assert.match(visibleText(html(STATES.full)), /ANTHROPIC_API_KEY\s+Missing/);
});

test("with no provider the page says not configured, with the push command", () => {
  const text = visibleText(html(STATES["not configured"]));
  assert.match(text, /not configured/);
  assert.match(text, /ratel sandbox push/);
  assert.doesNotMatch(visibleText(html()), /not configured/);
});

test("no text of the page names the provider", () => {
  for (const [name, state] of Object.entries(STATES)) {
    assert.match(visibleText(html(state)), /Ratel sandbox/, name);
    assert.doesNotMatch(html(state), /boat/i, name);
  }
});

test("the rail shows Ratel sandbox with the flag on only", async () => {
  const ids = (env: Record<string, string>) =>
    sandboxOrganizationIds([{ id: "org-1" }], {
      config: resolveConfig({ env }),
      port: undefined,
      edition: "Ratel OSS",
    });
  assert.deepEqual(await ids({}), []);
  assert.deepEqual(await ids({ FF_EVALS: "1" }), ["org-1"]);
  const nav = (sandboxPage?: boolean) =>
    consoleNav({ projectId: "p1", additions: [], ...(sandboxPage ? { sandboxPage } : {}) });
  const ofOff = flattenNav(nav()).map((item) => item.id);
  const ofOn = flattenNav(nav(true)).map((item) => item.id);
  assert.ok(!ofOff.includes("sandbox"));
  assert.deepEqual(
    ofOn.filter((id) => id !== "sandbox"),
    ofOff,
  );
  assert.ok(ofOn.includes("sandbox"));
});
