import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LABEL_MODEL } from "./model-defaults";
import { DEFAULT_LABEL_MODEL as WORKFLOW_LABEL_MODEL } from "./trace-signals/workflows/label-job";

test("the readings agree on the default naming model", () => {
  // The workflow label job (a mirrored upstream file) declares its own default; the engine's
  // cluster names and the topic names read this module's. Pinned until upstream shares one.
  assert.equal(WORKFLOW_LABEL_MODEL, DEFAULT_LABEL_MODEL);
});
