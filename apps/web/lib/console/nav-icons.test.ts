import assert from "node:assert/strict";
import { test } from "node:test";
import { HeartPulse, ListChecks } from "lucide-react";
import { NAV_ICONS } from "@/components/console/shell/nav-icons";

test("Tasks uses ListChecks and Agent health keeps HeartPulse", () => {
  assert.equal(NAV_ICONS.tasks, ListChecks);
  assert.equal(NAV_ICONS.health, HeartPulse);
});
