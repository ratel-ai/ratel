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
  spec: {
    inputExample: { message: "Where is my order 7?" },
    params: [
      {
        name: "model",
        type: "enum",
        default: "small",
        description: "The model that answers",
        options: ["small", "large"],
      },
      { name: "temperature", type: "number", default: 0.2, description: null, options: [] },
      {
        name: "strict",
        type: "boolean",
        default: true,
        description: "Refuse unclear asks",
        options: [],
      },
      { name: "persona", type: "string", default: null, description: null, options: [] },
    ],
    tools: [
      { name: "lookup_order", mode: "live" },
      { name: "refund_order", mode: "simulated" },
    ],
    runMode: "http",
    timeoutSeconds: 120,
  },
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
    usage: { durationMs: 2400, costUsd: 0.0132, inputTokens: 812, outputTokens: 64 },
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
  problems: [],
  canEdit: true,
  versions: [],
  secrets: [],
  runs: [],
  ...over,
});
const html = (over: Partial<SandboxPageModel> = {}, canSaveCases = true) =>
  render(
    createElement(SandboxView, {
      model: model(over),
      ratelUrl: "https://ratel.example",
      canSaveCases,
      now: NOW,
    }),
  );
const STATES: Record<string, Partial<SandboxPageModel>> = {
  empty: {},
  "not configured": {
    configured: false,
    problems: [
      { setting: "SANDBOX_PROVIDER", message: "No provider runs sandboxes on this server." },
      { setting: "SANDBOX_SECRETS_KEY", message: "SANDBOX_SECRETS_KEY is not configured." },
    ],
  },
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

test("the run shows the output first, then the tool calls with their mode, the numbers and the trace", () => {
  const page = html(STATES.full);
  const text = visibleText(page);
  for (const words of [
    "It is refunded.",
    "lookup_order",
    "Live",
    "refund_order",
    "Simulated",
    "2.4 s",
    "$0.0132",
    "812 in · 64 out",
    "Save as case",
    "Last runs",
  ]) {
    assert.ok(text.includes(words), words);
  }
  assert.ok(text.indexOf("It is refunded.") < text.indexOf("Tool calls"), "the output is first");
  assert.ok(page.includes(`href="/project/${PROJECT_ID}/traces/${"c".repeat(32)}"`));
});

test("the run panel fills the input from the example and has one typed control for each param", () => {
  const page = html(STATES.full);
  const text = visibleText(page);
  assert.ok(page.includes("Where is my order 7?"), "the input example");
  assert.ok(page.includes('type="number"'), "a number field for temperature");
  assert.ok(page.includes('role="switch"'), "a switch for strict");
  for (const words of [
    "model",
    "temperature",
    "strict",
    "persona",
    "The model that answers",
    "Default: small",
  ]) {
    assert.ok(text.includes(words), words);
  }
  assert.doesNotMatch(text, /Params \(JSON\)/);
});

test("the version shows its declared input, params, tools with modes and run mode", () => {
  const text = visibleText(html(STATES.full));
  assert.match(text, /Declared: http run · 4 parameters · 2 tools/);
  assert.match(text, /Run mode/);
});

test("Save as case shows only when evals is on and the person can write", () => {
  assert.match(visibleText(html(STATES.full)), /Save as case/);
  assert.doesNotMatch(visibleText(html(STATES.full, false)), /Save as case/);
});

test("a wrong setting of the server shows in a banner with its name", () => {
  const text = visibleText(html(STATES["not configured"]));
  assert.match(text, /SANDBOX_PROVIDER/);
  assert.match(text, /SANDBOX_SECRETS_KEY\s*:\s*SANDBOX_SECRETS_KEY is not configured\./);
  const keyOnly = visibleText(
    html({ problems: [{ setting: "SANDBOX_SECRETS_KEY", message: "It is not set." }] }),
  );
  assert.match(keyOnly, /A setting of this server is missing/);
});

test("a declared secret with no value is marked missing", () => {
  assert.match(visibleText(html(STATES.full)), /ANTHROPIC_API_KEY\s+Missing/);
});

test("with no provider the page says not configured, with the push command", () => {
  const text = visibleText(html(STATES["not configured"]));
  assert.match(text, /not configured/);
  assert.match(text, /ratel push/);
  assert.match(text, /ratel\.yaml/);
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
  assert.deepEqual(await ids({ FF_SANDBOXES: "1" }), ["org-1"]);
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
