import assert from "node:assert/strict";
import { test } from "node:test";
import { NOUN_ICONS } from "@ratel/design-system/entity";
import { FIX_KIND_ICONS } from "@/components/console/fixes/kind-icons";
import { SIGNAL_KIND_ICONS } from "@/components/console/health/kinds";
import { KIND_ICONS } from "@/components/console/self-corrections/kind-marks";
import {
  CORRECTION_ICONS,
  ISSUE_FAMILY_ICONS,
  issueIcon,
  FIX_KIND_ICONS as TASK_FIX_KIND_ICONS,
} from "@/components/console/tasks/kind-icons";

// One icon per kind across the product: a fix, an issue or a self-correction
// looks the same on Fixes, Agent health, Self-corrections and a task's page.

test("a fix kind wears the Fixes page's mark on a task's page too", () => {
  assert.equal(TASK_FIX_KIND_ICONS, FIX_KIND_ICONS);
});

test("a self-correction kind wears the Self-corrections page's mark on a task's page", () => {
  assert.equal(CORRECTION_ICONS.retry_after_error, KIND_ICONS.retried);
  assert.equal(CORRECTION_ICONS.switch_after_error, KIND_ICONS.switched);
  assert.equal(CORRECTION_ICONS.gave_up_after_error, KIND_ICONS.gave_up);
  assert.equal(CORRECTION_ICONS.searched_again, KIND_ICONS.searched_again);
  assert.equal(CORRECTION_ICONS.asked_again, KIND_ICONS.asked_again);
  assert.equal(CORRECTION_ICONS.phrase, KIND_ICONS.apologized);
});

test("an issue wears its kind's Agent health mark on a task's page, the family's when the kind has none", () => {
  assert.equal(issueIcon({ kind: "error_loop", family: "retry" }), SIGNAL_KIND_ICONS.error_loop);
  assert.equal(
    issueIcon({ kind: "workflow_slow", family: "slow" }),
    SIGNAL_KIND_ICONS.workflow_slow,
  );
  assert.equal(issueIcon({ kind: "not_a_kind", family: "slow" }), ISSUE_FAMILY_ICONS.slow);
});

test("the self-correcting issue wears the self-correction noun's mark, and no other issue does", () => {
  assert.equal(SIGNAL_KIND_ICONS.self_correcting, NOUN_ICONS.selfCorrection);
  const others = Object.entries(SIGNAL_KIND_ICONS).filter(
    ([kind, icon]) => kind !== "self_correcting" && icon === NOUN_ICONS.selfCorrection,
  );
  assert.deepEqual(others, []);
});
