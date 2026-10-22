import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CompositionPorts } from "@/lib/contracts/composition";

process.env.RATEL_COMPOSITION = "oss";
const { createComposition } = await import("@/lib/composition");
const { scanEeBoundary } = await import("../../../../scripts/check-ee-boundary.mjs");

/** Stand-in commercial ports so tests do not reach into ee/ through the core tree. */
const cloudPorts: CompositionPorts = {
  identity: {
    async resolvePrincipal() {
      return { id: "cloud-operator", label: "fausto@ratel.sh · Acme Inc" };
    },
  },
  workspace: {
    async listWorkspaces() {
      return [
        { id: "ws-1", name: "Production" },
        { id: "ws-2", name: "Staging" },
        { id: "ws-3", name: "Sandbox" },
      ];
    },
    async currentWorkspace() {
      return { id: "ws-1", name: "Production" };
    },
  },
};

describe("createComposition", () => {
  it("assembles the OSS edition with both ports", async () => {
    const composition = createComposition("oss");
    assert.equal(composition.edition, "Ratel OSS");

    const principal = await composition.identity.resolvePrincipal();
    assert.ok(principal);
    assert.equal(principal.label, "Local operator");

    const workspaces = await composition.workspace.listWorkspaces();
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].name, "Local workspace");
  });

  it("assembles the Cloud edition with three workspaces", async () => {
    const composition = createComposition("cloud", { eeComposition: cloudPorts });
    assert.equal(composition.edition, "Ratel Cloud");

    const workspaces = await composition.workspace.listWorkspaces();
    assert.equal(workspaces.length, 3);

    const current = await composition.workspace.currentWorkspace();
    assert.equal(current.id, workspaces[0].id);
  });

  it("throws when a port is missing or the edition key is unknown", () => {
    assert.throws(
      () => createComposition("oss", { ports: { workspace: undefined } }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /workspace/);
        return true;
      },
    );

    assert.throws(
      () => createComposition("nope"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /RATEL_COMPOSITION/);
        assert.match(error.message, /oss/);
        assert.match(error.message, /cloud/);
        return true;
      },
    );
  });

  it("supplies nav for Cloud and an empty nav for OSS", () => {
    const oss = createComposition("oss");
    assert.deepEqual(oss.nav, []);

    const cloud = createComposition("cloud", { eeComposition: cloudPorts });
    assert.equal(cloud.nav.length, 1);
    assert.equal(cloud.nav[0].href, "/admin");
  });

  it("throws when cloud is requested but the seam is null", () => {
    assert.throws(
      () => createComposition("cloud", { eeComposition: null }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /excludes the commercial modules/);
        return true;
      },
    );
  });

  it("reports zero ee boundary violations on the real tree", () => {
    const violations = scanEeBoundary();
    assert.deepEqual(violations, []);
  });
});
