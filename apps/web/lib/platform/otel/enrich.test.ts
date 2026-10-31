import assert from "node:assert/strict";
import { test } from "node:test";
import { annotateActiveSpan } from "./enrich";

test("span enrichment is a no-op without an active provider span", () => {
  assert.doesNotThrow(() => {
    annotateActiveSpan({ project_id: "project-1", org_id: "org-1" }, () => undefined);
  });
});

test("request context maps to stable span attribute names", () => {
  let captured: Record<string, unknown> | undefined;
  const activeSpan = {
    setAttributes(attributes: Record<string, unknown>) {
      captured = attributes;
      return this;
    },
  };

  annotateActiveSpan(
    {
      project_id: "project-1",
      org_id: "org-1",
      distinctId: "project:project-1",
    },
    () => activeSpan,
  );

  assert.deepEqual(captured, {
    "ratel.project_id": "project-1",
    "ratel.org_id": "org-1",
    distinctId: "project:project-1",
  });
});

test("request context enriches the request root instead of the active child", () => {
  let activeAttributes: Record<string, unknown> | undefined;
  let rootAttributes: Record<string, unknown> | undefined;
  const activeSpan = {
    setAttributes(attributes: Record<string, unknown>) {
      activeAttributes = attributes;
      return this;
    },
  };
  const rootSpan = {
    setAttributes(attributes: Record<string, unknown>) {
      rootAttributes = attributes;
      return this;
    },
  };

  annotateActiveSpan(
    { project_id: "project-1", org_id: "org-1" },
    () => activeSpan,
    () => rootSpan,
  );

  assert.equal(activeAttributes, undefined);
  assert.deepEqual(rootAttributes, {
    "ratel.project_id": "project-1",
    "ratel.org_id": "org-1",
  });
});
