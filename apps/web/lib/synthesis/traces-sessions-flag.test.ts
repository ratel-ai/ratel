import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { tracesSessionsEnabled } from "@/lib/synthesis/traces-sessions-flag";

test("the Sessions tab is off by default and on with FF_TRACES_SESSIONS", () => {
  assert.equal(tracesSessionsEnabled({}), false);
  assert.equal(tracesSessionsEnabled({ FF_TRACES_SESSIONS: "0" }), false);
  assert.equal(tracesSessionsEnabled({ FF_TRACES_SESSIONS: "1" }), true);
});

test("the tabs layout and the summary route read the switch, not upstream's flag service (the sessions list is on for everyone, as upstream reads it since #416)", () => {
  for (const file of [
    "../../app/(console)/project/[projectId]/traces/(tabs)/layout.tsx",
    "../../app/api/projects/[projectId]/traces/summary/route.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /tracesSessionsEnabled\(\)/, file);
    assert.doesNotMatch(source, /flagEnabled\(/, file);
  }
});
