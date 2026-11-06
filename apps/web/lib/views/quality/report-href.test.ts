import assert from "node:assert/strict";
import { test } from "node:test";
import { qualityReportHref, reportWindowDays } from "./report-href";

test("the report link names the project, the calibration and the window", () => {
  assert.equal(
    qualityReportHref("project-1", "reranker shadow/v2", 30),
    "/report/quality/project-1?calibration=reranker%20shadow%2Fv2&days=30",
  );
});

test("the window is the page's range in whole days, never less than one", () => {
  const since = new Date("2026-10-01T00:00:00.000Z");
  assert.equal(reportWindowDays({ since, until: new Date("2026-10-31T00:00:00.000Z") }), 30);
  assert.equal(reportWindowDays({ since, until: new Date("2026-10-07T13:00:00.000Z") }), 7);
  assert.equal(reportWindowDays({ since, until: new Date("2026-10-01T02:00:00.000Z") }), 1);
});
