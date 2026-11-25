import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { CaseEditor } from "@/components/console/evals/CaseEditor";
import { EvalCasesView } from "@/components/console/evals/EvalCasesView";
import { resolveConfig } from "@/config";
import { consoleNav, flattenNav } from "@/lib/console/navigation";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";
import { evalsEnabledForProject, evalsOffForAll, evalsOrganizationIds } from "../gate";
import type { CaseEditorModel, CaseVersionView } from "../page-model";
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
    createElement(EvalCasesView, {
      projectId: PROJECT_ID,
      canEdit: true,
      now: NOW,
      cases: [{ ...row, approved: 1, draft: 2 }],
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
  assert.match(page, /evalsEnabledForProject\(project\.id\)\) \? \(\s*<SaveAsEvalCase/);
  assert.match(source("(evals)/project/[projectId]/layout.tsx"), /notFound\(\)/);
});
