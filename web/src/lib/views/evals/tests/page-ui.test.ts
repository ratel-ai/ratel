import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { CaseEditor } from "@/components/console/evals/CaseEditor";
import { EvalsView } from "@/components/console/evals/EvalsView";
import { ExperimentView } from "@/components/console/evals/ExperimentView";
import { resolveConfig } from "@/config";
import { consoleNav, flattenNav } from "@/lib/console/navigation";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";
import type { Experiment, Trial } from "../domain/experiment";
import { evalsEnabledForProject, evalsOffForAll, evalsOrganizationIds } from "../gate";
import {
  type CaseEditorModel,
  type CaseVersionView,
  experimentPageModel,
  readyVersions,
} from "../page-model";
import { content } from "./support";

const NOW = "2026-11-25T10:00:00.000Z";
const version = (over: Partial<CaseVersionView> = {}): CaseVersionView => ({
  ...content(),
  id: "v1",
  caseId: "c1",
  number: 1,
  state: "approved",
  sourceTurnId: "t1",
  sourceOutput: "Refunded.",
  approvedBy: "user_1",
  approvedAt: NOW,
  updatedAt: NOW,
  ...over,
});
const model = (over: Partial<CaseEditorModel> = {}): CaseEditorModel => ({
  projectId: PROJECT_ID,
  canEdit: true,
  id: "c1",
  name: "Late refund",
  labels: ["task: refunds"],
  approved: null,
  draft: version({ state: "draft" }),
  ...over,
});
const labels = (evalsPage: boolean) =>
  flattenNav(consoleNav({ projectId: PROJECT_ID, additions: [], evalsPage })).map(
    ({ label }) => label,
  );

test("evals are off by default, and FF_EVALS=1 turns them on", async () => {
  assert.equal(await evalsEnabledForProject("p1", { config: resolveConfig() }), false);
  assert.equal(evalsOffForAll({ config: resolveConfig(), port: undefined }), true);
  const config = resolveConfig({ env: { FF_EVALS: "1" } });
  assert.equal(await evalsEnabledForProject("p1", { config }), true);
  assert.deepEqual(await evalsOrganizationIds([{ id: "o1" }], { config }), ["o1"]);
});

test("the rail has Evals only with the flag on", () => {
  assert.ok(labels(true).includes("Evals"));
  assert.ok(!labels(false).includes("Evals"));
});

test("the list shows which version counts", () => {
  const row = { id: "c1", name: "Late refund", labels: ["task: refunds"], createdAt: NOW };
  const html = render(
    createElement(EvalsView, {
      projectId: PROJECT_ID,
      canEdit: true,
      now: NOW,
      cases: [{ ...row, approved: 1, draft: 2 }],
      experiments: [],
      versions: [],
    }),
  );
  const text = visibleText(html);
  for (const part of ["Late refund", "Approved v1", "Draft v2", "task: refunds", "New case"]) {
    assert.ok(text.includes(part), part);
  }
});

test("the editor of an approved case with a draft shows both", () => {
  const html = render(
    createElement(CaseEditor, {
      model: model({
        approved: version(),
        draft: version({ id: "v2", number: 2, state: "draft" }),
      }),
    }),
  );
  const text = visibleText(html);
  assert.match(text, /Version 1 counts in eval runs/);
  assert.match(text, /Draft v2/);
  assert.match(text, /No refund \(gating\): tools is not refund_order/);
  assert.match(html, /traces\/turns\/t1/);
});

test("a support session sees no action", () => {
  const text = visibleText(render(createElement(CaseEditor, { model: model({ canEdit: false }) })));
  assert.ok(!text.includes("Approve"));
  assert.ok(!text.includes("Save draft"));
});

test("the turn page shows the action behind the flag, and the pages are under the gated layout", () => {
  const source = (path: string) =>
    readFileSync(
      fileURLToPath(new URL(`../../../../app/(console)/${path}`, import.meta.url)),
      "utf8",
    );
  const page = source("project/[projectId]/traces/turns/[turnId]/page.tsx");
  assert.match(
    page,
    /evalsEnabledForProject\(project\.id\)\) &&\s*!\(await isRestrictedBySupportSession\(\)\) &&\s*\(await contentOptIn\(project\.id\)\);\s*const saveAction = canSave \? \(?\s*<SaveAsEvalCase/,
  );
  assert.match(source("../(evals)/project/[projectId]/layout.tsx"), /notFound\(\)/);
});

test("the experiment page shows the raw counts of each case, and links each trial to its trace", () => {
  const trial = (over: Partial<Trial>): Trial => ({
    id: crypto.randomUUID(),
    experimentId: "e1",
    caseVersionId: "v1",
    index: 0,
    state: "done",
    result: "pass",
    reason: null,
    scorers: [],
    costUsd: 0.01,
    durationMs: 900,
    traceId: "c".repeat(32),
    sandboxRunId: "r1",
    ...over,
  });
  const experiment: Experiment = {
    id: "e1",
    projectId: PROJECT_ID,
    organizationId: "o1",
    sandboxVersionId: "sv1",
    sandboxName: "support-demo",
    gitCommit: "b".repeat(40),
    gitDirty: false,
    params: { model: "x" },
    trialsPerCase: 3,
    caseVersions: [{ caseId: "c1", versionId: "v1", number: 2, name: "Late refund" }],
    scorerSnapshots: {},
    startedBy: "u",
    state: "completed",
    createdAt: new Date(NOW),
    finishedAt: new Date(NOW),
  };
  const model = experimentPageModel(experiment, [
    trial({}),
    trial({
      index: 1,
      result: "fail",
      scorers: [
        {
          scorerId: "s",
          name: "No refund",
          kind: "check",
          gating: true,
          status: "fail",
          reason: "tools ne refund_order: the value is there.",
        },
        {
          scorerId: "j",
          name: "Polite",
          kind: "judge",
          gating: true,
          status: "not_scored",
          reason: "The judge budget of this organization for today (100 USD) is used.",
        },
      ],
    }),
    trial({ index: 2, result: "invalid", reason: "timed_out: no result", traceId: null }),
  ]);
  const html = render(createElement(ExperimentView, { model, now: NOW }));
  const text = visibleText(html);
  assert.equal(text.match(/1 pass/g)?.length, 2, "the total and the case");
  for (const part of ["1 fail", "1 invalid", "Late refund", "timed_out: no result", "sv1"]) {
    assert.ok(text.includes(part), part);
  }
  assert.match(text, /No refund\s*gating\s*tools ne refund_order/);
  // A judge that could not run shows its reason next to the fail of the trial.
  assert.match(
    text,
    /Trial 2\s*Fail[\s\S]*Not scored\s*Polite\s*gating\s*The judge budget [\s\S]*100 USD/,
  );
  assert.match(html, new RegExp(`traces/${"c".repeat(32)}`));
});

test("Run evals lists ready versions only, and is not there in a support session", () => {
  const version = (id: string, status: "ready" | "failed") => ({
    id,
    projectId: PROJECT_ID,
    sandboxId: "s",
    name: "support-demo",
    git: { commit: "b".repeat(40), dirty: false },
    status,
    createdAt: new Date(),
    tools: [],
  });
  const versions = readyVersions([version("1", "failed"), version("2", "ready")]);
  assert.deepEqual(
    versions.map(({ id }) => id),
    ["2"],
  );
  const view = (canEdit: boolean) =>
    visibleText(
      render(
        createElement(EvalsView, {
          projectId: PROJECT_ID,
          canEdit,
          now: NOW,
          cases: [],
          experiments: [],
          versions,
        }),
      ),
    );
  assert.ok(view(true).includes("No case is approved yet."));
  assert.ok(!view(false).includes("Run evals"));
});
