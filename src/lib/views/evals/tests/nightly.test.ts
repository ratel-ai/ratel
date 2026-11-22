import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { NightlyToggle } from "@/components/console/evals/NightlyToggle";
import { RunsList } from "@/components/console/evals/RunsList";
import { composition } from "@/lib/composition/ports";
import type { EvalRun } from "@/lib/views/evals/domain/types";
import { NIGHTLY_CAP_ERROR, nightlyControlFor, nightlyDue } from "@/lib/views/evals/nightly";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";

/**
 * Owned (ADR-0030): the core's plans are the entitlements port's. A stand-in port reads upstream's
 * plan fields the way upstream does: a paid plan needs an active subscription.
 */
composition.entitlements = {
  ...composition.entitlements,
  planId: (org) =>
    org.plan !== "free" && org.subscriptionStatus === "active" ? String(org.plan) : "free",
};

const PAID = {
  id: "org-paid",
  plan: "pro",
  subscriptionStatus: "active",
  planOverride: null,
  limitOverrides: null,
};
const FREE = {
  id: "org-free",
  plan: "free",
  subscriptionStatus: null,
  planOverride: null,
  limitOverrides: null,
};
const LAPSED = {
  id: "org-lapsed",
  plan: "pro",
  subscriptionStatus: "canceled",
  planOverride: null,
  limitOverrides: null,
};
const SET_AT = new Date("2026-11-07T08:00:00Z");

test("due once per UTC day: none yet, yesterday's, and today's", () => {
  const now = new Date("2026-11-08T00:05:00Z");
  assert.equal(nightlyDue(null, now), true);
  assert.equal(nightlyDue(new Date("2026-11-07T23:59:00Z"), now), true);
  assert.equal(nightlyDue(new Date("2026-11-08T00:01:00Z"), now), false);
  assert.equal(
    nightlyDue(new Date("2026-11-08T23:00:00Z"), new Date("2026-11-08T23:30:00Z")),
    false,
  );
});

test("the toggle shows for admins on paid plans only", () => {
  const setting = { enabled: true, setBy: "user_1", setAt: SET_AT };
  assert.deepEqual(nightlyControlFor("admin", PAID, setting), setting);
  assert.deepEqual(
    nightlyControlFor("admin", PAID, null),
    { enabled: false, setBy: null, setAt: null },
    "No row: off.",
  );
  assert.equal(nightlyControlFor("member", PAID, setting), null);
  assert.equal(nightlyControlFor("admin", FREE, setting), null);
  assert.equal(
    nightlyControlFor("admin", LAPSED, setting),
    null,
    "A lapsed subscription reads as free.",
  );

  const on = visibleText(
    render(createElement(NightlyToggle, { projectId: PROJECT_ID, control: setting, capUsd: 1 })),
  );
  assert.match(on, /Run nightly/);
  assert.match(on, /\$1 a day/);
  assert.equal(
    render(createElement(NightlyToggle, { projectId: PROJECT_ID, control: null, capUsd: 1 })),
    "",
  );
});

test("runs list: a nightly run stopped at the cap says why", () => {
  const run: EvalRun = {
    id: "33333333-3333-4333-8333-333333333333",
    projectId: PROJECT_ID,
    kind: "nightly",
    fixId: null,
    suite: "All evals",
    status: "failed",
    spend: { usd: 0, reservedUsd: 0, reserved: false },
    evalCount: 3,
    error: NIGHTLY_CAP_ERROR,
    createdBy: "system:evals-nightly",
    createdAt: SET_AT,
    startedAt: SET_AT,
    finishedAt: SET_AT,
  };
  const text = visibleText(
    render(
      createElement(RunsList, {
        projectId: PROJECT_ID,
        rows: [
          { run, suite: run.suite, summary: { passed: 0, total: 0, nowFails: 0, fixed: 0 } },
          {
            run: { ...run, id: "a", status: "completed" },
            suite: run.suite,
            summary: { passed: 2, total: 3, nowFails: 0, fixed: 0 },
          },
        ],
      }),
    ),
  );
  assert.ok(text.includes("Nightly"));
  assert.equal(
    text.split(NIGHTLY_CAP_ERROR).length - 1,
    2,
    "Failed and completed-but-stopped runs both say why.",
  );
});
