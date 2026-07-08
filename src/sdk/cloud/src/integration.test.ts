/**
 * End to end over real parts: a `SkillCatalog` hydrated from the mock source
 * through `createSkillSync`, retrieved through the capability tools.
 */

import {
  type SearchCapabilitiesResult,
  SkillCatalog,
  searchCapabilitiesTool,
  ToolCatalog,
} from "@ratel-ai/sdk";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { CatalogSkillWire } from "./canonical.js";
import { createSkillSync, type SkillSyncHandle } from "./index.js";
import { type MockSource, startMockSource } from "./testing/mock-source.js";

const API_KEY = "test-key";

const deploySkill: CatalogSkillWire = {
  id: "deploy-service",
  name: "deploy-service",
  description: "Deploy a service to production with health checks and rollback.",
  tags: ["deploy", "release"],
  tools: [],
  metadata: {},
  body: "# Deploy\n1. Build\n2. Ship\n",
};

const auditSkill: CatalogSkillWire = {
  id: "audit-logs",
  name: "audit-logs",
  description: "Collect and summarize audit logs for a time range.",
  tags: ["logs"],
  tools: [],
  metadata: {},
  body: "# Audit\n",
};

let source: MockSource;
let handle: SkillSyncHandle;

beforeAll(async () => {
  source = await startMockSource({ apiKey: API_KEY });
});

afterAll(async () => {
  await source.close();
});

afterEach(() => {
  handle?.stop();
});

it("flips the live capability-tool description once the sync hydrates skills", async () => {
  source.setSkills([deploySkill]);
  const skillCatalog = new SkillCatalog();
  const capabilityTool = searchCapabilitiesTool(new ToolCatalog(), skillCatalog);
  expect(capabilityTool.description).not.toContain("get_skill_content");

  handle = createSkillSync(skillCatalog, { url: source.url, apiKey: API_KEY });
  await handle.refresh();
  expect(capabilityTool.description).toContain("get_skill_content");
});

it("hydrates, retrieves, removes, and preserves host skills end to end", async () => {
  source.setSkills([deploySkill, auditSkill]);
  const skillCatalog = new SkillCatalog();
  skillCatalog.register({
    id: "audit-logs",
    name: "host-audit",
    description: "Host-registered audit skill.",
    body: "host body",
  });
  const capabilityTool = searchCapabilitiesTool(new ToolCatalog(), skillCatalog);

  // Before hydration only the host skill exists; after the first refresh the
  // live description advertises the skills bucket.
  expect(skillCatalog.size()).toBe(1);
  handle = createSkillSync(skillCatalog, { url: source.url, apiKey: API_KEY });
  const first = await handle.refresh();
  expect(skillCatalog.size()).toBe(2);
  expect(handle.ownedCount).toBe(1);
  expect(capabilityTool.description).toContain("get_skill_content");

  // The host-registered skill with the colliding id survived untouched.
  expect(first.conflicts).toEqual(["audit-logs"]);
  expect(skillCatalog.get("audit-logs")?.name).toBe("host-audit");

  // The capability-tools search over the catalog finds the synced skill.
  const hit = (await capabilityTool.execute({
    query: "deploy a service to production",
  })) as SearchCapabilitiesResult;
  expect(hit.skills.map((s) => s.skillId)).toContain("deploy-service");

  // A skill removed on the source disappears after the next refresh.
  source.setSkills([auditSkill]);
  const second = await handle.refresh();
  expect(second.removed).toBe(1);
  expect(skillCatalog.has("deploy-service")).toBe(false);
  const gone = (await capabilityTool.execute({
    query: "deploy a service to production",
  })) as SearchCapabilitiesResult;
  expect(gone.skills.map((s) => s.skillId)).not.toContain("deploy-service");
  expect(skillCatalog.get("audit-logs")?.name).toBe("host-audit");
});
