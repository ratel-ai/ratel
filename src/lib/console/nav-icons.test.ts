import assert from "node:assert/strict";
import { test } from "node:test";
import { Building2, HeartPulse, ListChecks, Plug } from "lucide-react";
import { NAV_ICONS } from "@/components/console/shell/nav-icons";

test("Tasks uses ListChecks and Agent health keeps HeartPulse", () => {
  assert.equal(NAV_ICONS.tasks, ListChecks);
  assert.equal(NAV_ICONS.health, HeartPulse);
});

test("the APIs row is a plug and Projects a building, as upstream's rail", () => {
  assert.equal(NAV_ICONS.apis, Plug);
  assert.equal(NAV_ICONS.projects, Building2);
});
