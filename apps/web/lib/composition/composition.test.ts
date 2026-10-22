import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.RATEL_COMPOSITION = "oss";
const { createComposition } = await import("@/lib/composition");

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
    const composition = createComposition("cloud");
    assert.equal(composition.edition, "Ratel Cloud");

    const workspaces = await composition.workspace.listWorkspaces();
    assert.equal(workspaces.length, 3);

    const current = await composition.workspace.currentWorkspace();
    assert.equal(current.id, workspaces[0].id);
  });

  it("throws when a port is missing or the edition key is unknown", () => {
    assert.throws(
      () => createComposition("oss", { workspace: undefined }),
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
});
