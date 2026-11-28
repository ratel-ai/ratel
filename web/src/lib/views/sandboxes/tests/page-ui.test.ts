import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { NewSandboxSteps } from "@/components/console/sandboxes/NewSandboxDialog";
import { SandboxesList } from "@/components/console/sandboxes/SandboxesList";
import { SandboxView } from "@/components/console/sandboxes/SandboxView";
import { resolveConfig } from "@/config";
import { consoleNav, flattenNav } from "@/lib/console/navigation";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";
import { sandboxOrganizationIds } from "../gate";
import type { RunRow, SandboxDetailModel, SandboxListModel, VersionRow } from "../page-model";
import type { SandboxSection } from "../paths";

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
    network: ["api.openai.com"],
    secrets: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SEARCH_KEY"],
  },
  ...over,
});
const run: RunRow = {
  runId: "77777777-7777-4777-8777-777777777777",
  versionId: version().id,
  status: "completed",
  reason: null,
  errorCode: null,
  logs: "agent booted\nrefund_order simulated\n",
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
const SERVER = { projectId: PROJECT_ID, configured: true, problems: [], canEdit: true };
const NOT_CONFIGURED = {
  configured: false,
  problems: [
    { setting: "SANDBOX_PROVIDER", message: "No provider runs sandboxes on this server." },
    { setting: "SANDBOX_SECRETS_KEY", message: "SANDBOX_SECRETS_KEY is not configured." },
  ],
};
const detail = (over: Partial<SandboxDetailModel> = {}): SandboxDetailModel => ({
  ...SERVER,
  name: "support-demo",
  versions: [version()],
  secrets: [],
  undeclared: [],
  runs: [],
  ...over,
});
const html = (
  over: Partial<SandboxDetailModel> = {},
  section: SandboxSection = "playground",
  canSaveCases = true,
) =>
  render(createElement(SandboxView, { model: detail(over), section, canSaveCases, now: NOW }), {
    pathname: `/project/${PROJECT_ID}/sandboxes/support-demo`,
  });
const list = (over: Partial<SandboxListModel> = {}): SandboxListModel => ({
  ...SERVER,
  sandboxes: [
    {
      name: "support-demo",
      href: `/project/${PROJECT_ID}/sandboxes/support-demo`,
      newest: { id: version().id, status: "ready", reason: null, commit: COMMIT },
      versions: 3,
      lastPushAt: NOW,
      lastRunAt: null,
    },
  ],
  projectSecrets: [
    { name: "OPENAI_API_KEY", updatedAt: NOW, declaredBy: ["support-demo"] },
    { name: "SEARCH_KEY", updatedAt: null, declaredBy: ["support-demo"] },
  ],
  ...over,
});
const listHtml = (over: Partial<SandboxListModel> = {}) =>
  render(
    createElement(SandboxesList, {
      model: list(over),
      projectName: "Agent",
      ratelUrl: "https://ratel.example",
      now: NOW,
    }),
    { pathname: `/project/${PROJECT_ID}/sandboxes` },
  );
const steps = () =>
  render(
    createElement(NewSandboxSteps, {
      projectId: PROJECT_ID,
      projectName: "Agent",
      ratelUrl: "https://ratel.example",
    }),
  );
const FULL: Partial<SandboxDetailModel> = {
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
    { name: "ANTHROPIC_API_KEY", source: "missing", updatedAt: null },
    { name: "OPENAI_API_KEY", source: "sandbox", updatedAt: NOW },
    { name: "SEARCH_KEY", source: "project", updatedAt: NOW },
  ],
  undeclared: [{ name: "OLD_KEY", updatedAt: NOW }],
  runs: [run],
};
const NO_RESULT: Partial<SandboxDetailModel> = {
  runs: [
    {
      ...run,
      status: "timed_out",
      result: null,
      traceId: null,
      reason: "The run had no result before its timeout.",
    },
  ],
};

test("the list is a table of the sandboxes: name, newest version with its status, last push, last run", () => {
  const page = listHtml();
  const text = visibleText(page);
  for (const words of ["Sandboxes", "Name", "Newest version", "Last push", "Last run"]) {
    assert.ok(text.includes(words), words);
  }
  assert.match(text, /support-demo\s+Ready\s+b1c2d3e4f5a6\s+3 versions/);
  assert.match(text, /No run yet/);
  assert.ok(page.includes(`href="/project/${PROJECT_ID}/sandboxes/support-demo"`));
  assert.match(text, /New sandbox/);
  assert.match(visibleText(listHtml({ sandboxes: [] })), /No sandbox yet/);
});

test("the list has the project secrets, with the sandboxes that use each name", () => {
  const page = listHtml();
  assert.ok(page.includes('id="project-secrets"'));
  const text = visibleText(page);
  assert.match(text, /Project secrets/);
  assert.match(text, /SEARCH_KEY\s+No project value\s+used by support-demo/);
});

test("the New sandbox dialog explains ratel.yaml, the Dockerfile and ratel push with the real values", () => {
  const page = steps();
  const text = visibleText(page);
  assert.match(text, /ratel\.yaml/);
  assert.match(text, /Dockerfile/);
  assert.match(text, /FROM node/);
  assert.match(text, /ratel push/);
  // The CLI reads RATEL_BASE_URL (with /api/v1). With another name it pushes to its default server.
  assert.match(text, /export RATEL_BASE_URL=https:\/\/ratel\.example\/api\/v1/);
  assert.doesNotMatch(text, /RATEL_URL=/);
  assert.match(text, /a key of Agent/);
  assert.ok(page.includes(`href="/project/${PROJECT_ID}/settings/api-keys"`));
  assert.doesNotMatch(page, /<form|method="post"/i, "it creates nothing");
});

test("a sandbox page has the sections Playground, Versions, Secrets and Configuration, each at its address", () => {
  const page = html();
  const root = `/project/${PROJECT_ID}/sandboxes/support-demo`;
  for (const href of [root, `${root}/versions`, `${root}/secrets`, `${root}/configuration`]) {
    assert.ok(page.includes(`href="${href}"`), href);
  }
  const text = visibleText(page);
  assert.ok(
    text.indexOf("Playground") < text.indexOf("Versions") &&
      text.indexOf("Versions") < text.indexOf("Secrets") &&
      text.indexOf("Secrets") < text.indexOf("Configuration"),
  );
  assert.ok(page.includes(`href="/project/${PROJECT_ID}/sandboxes"`), "the crumb to the list");
});

test("Versions shows each state, its commit, its smoke check and its log", () => {
  const text = visibleText(html(FULL, "versions"));
  for (const words of [
    "support-demo",
    "Ready",
    "Failed",
    COMMIT.slice(0, 12),
    "install command 1",
    "Preparing",
    "no_health",
    "Smoke check logs",
    "Configuration: http run · 4 parameters · 2 tools",
  ]) {
    assert.ok(text.includes(words), words);
  }
});

test("the Playground shows the output first, then the tool calls with their mode, the numbers and the trace", () => {
  const page = html(FULL);
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
    "Save as eval case",
    "Last runs",
  ]) {
    assert.ok(text.includes(words), words);
  }
  // The required order: output, tool calls, logs, duration, cost, trace link.
  const order = ["It is refunded.", "Tool calls", "Logs", "Duration", "Cost", "Open the trace"];
  const at = order.map((words) => text.indexOf(words));
  assert.ok(!at.includes(-1), `every part is there: ${at}`);
  assert.deepEqual(
    at,
    [...at].sort((left, right) => left - right),
    "the parts are in order",
  );
  assert.ok(page.includes(`href="/project/${PROJECT_ID}/traces/${"c".repeat(32)}"`));
});

test("the Playground fills the input from the example and has one typed control for each param", () => {
  const page = html(FULL);
  const text = visibleText(page);
  assert.ok(page.includes("Where is my order 7?"), "the input example");
  assert.ok(page.includes('type="number"'), "a number field for temperature");
  assert.ok(page.includes('role="switch"'), "a switch for strict");
  for (const words of [
    "Version",
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

test("Configuration shows the parsed ratel.yaml: run mode, input, params, tools with modes, network, secrets", () => {
  const text = visibleText(html(FULL, "configuration"));
  for (const words of [
    "Run mode",
    "http · timeout 120 s",
    "Input example",
    "Parameters",
    "small | large = small",
    "lookup_order live",
    "refund_order simulated",
    "Network",
    "api.openai.com",
    "SEARCH_KEY",
  ]) {
    assert.ok(text.includes(words), words);
  }
});

test("Save as eval case shows only when evals is on and the person can write", () => {
  assert.match(visibleText(html(FULL)), /Save as eval case/);
  assert.doesNotMatch(visibleText(html(FULL, "playground", false)), /Save as eval case/);
});

test("Secrets shows each declared name with its source, the undeclared values and a link to the project secrets", () => {
  const page = html(FULL, "secrets");
  const text = visibleText(page);
  assert.match(text, /ANTHROPIC_API_KEY\s+Missing\s+Set for this sandbox/);
  assert.match(text, /OPENAI_API_KEY\s+Sandbox value/);
  assert.match(text, /SEARCH_KEY\s+Project value\s+set .*Set for this sandbox/);
  assert.match(text, /OLD_KEY\s+Not declared/);
  assert.ok(page.includes(`href="/project/${PROJECT_ID}/sandboxes#project-secrets"`));
});

test("a wrong setting of the server shows in a banner with its name; no provider says not configured", () => {
  const text = visibleText(html(NOT_CONFIGURED));
  assert.match(text, /Sandboxes are not configured/);
  assert.match(text, /SANDBOX_PROVIDER/);
  assert.match(text, /SANDBOX_SECRETS_KEY\s*:\s*SANDBOX_SECRETS_KEY is not configured\./);
  assert.match(visibleText(listHtml(NOT_CONFIGURED)), /not configured/);
  assert.doesNotMatch(visibleText(listHtml()), /not configured/);
  const keyOnly = visibleText(
    html({ problems: [{ setting: "SANDBOX_SECRETS_KEY", message: "It is not set." }] }),
  );
  assert.match(keyOnly, /A setting of this server is missing/);
});

test("no text says Ratel sandbox or Try a version, and none names the provider", () => {
  const pages = {
    list: listHtml(),
    "list not configured": listHtml(NOT_CONFIGURED),
    dialog: steps(),
    ...Object.fromEntries(
      (["playground", "versions", "secrets", "configuration"] as const).flatMap((section) => [
        [section, html(FULL, section)],
        [`${section} no result`, html(NO_RESULT, section)],
        [`${section} not configured`, html(NOT_CONFIGURED, section)],
      ]),
    ),
  };
  for (const [name, page] of Object.entries(pages)) {
    assert.doesNotMatch(visibleText(page), /Ratel sandbox|Try a version/i, name);
    assert.doesNotMatch(page, /boat/i, name);
  }
});

test("the rail shows Sandboxes with the flag on only, at the list address", async () => {
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
  const items = flattenNav(nav(true));
  const ofOn = items.map((item) => item.id);
  assert.ok(!ofOff.includes("sandboxes"));
  assert.deepEqual(
    ofOn.filter((id) => id !== "sandboxes"),
    ofOff,
  );
  const entry = items.find((item) => item.id === "sandboxes");
  assert.equal(entry?.label, "Sandboxes");
  assert.equal(entry?.href, "/project/p1/sandboxes");
});
