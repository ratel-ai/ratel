import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoCommitRow, RepoLinkRow } from "@/lib/views/code-handoff/schema";
import type { RecordFixShipmentInput } from "@/lib/views/fixes/record-shipment";
import type { FixShipmentRow } from "@/lib/views/fixes/schema";
import type { Fix } from "@/lib/views/fixes/types";
import { type RecordDeployDeps, recordDeploy } from "./deployed";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const FIX_A = "craft:0b6c3a8e-1f2d-4c5b-9a7e-3d2c1b0a9f8e";
const FIX_B = "rewrite:1b6c3a8e-1f2d-4c5b-9a7e-3d2c1b0a9f8e";
const FIX_GONE = "issue:2b6c3a8e-1f2d-4c5b-9a7e-3d2c1b0a9f8e";
const LINK: RepoLinkRow = {
  id: "link-1",
  projectId: PROJECT,
  installationId: 9,
  repoId: 501,
  owner: "acme",
  name: "agent",
  defaultBranch: "main",
  linkedBy: "user_a",
  createdAt: new Date(0),
};

function commit(seq: number, sha: string, fixIds: string[] = []): RepoCommitRow {
  return {
    id: `c${seq}`,
    repoLinkId: LINK.id,
    sha,
    messageHead: `commit ${seq}`,
    authorLogin: "ana",
    pushedAt: new Date(0),
    seq,
    fixIds,
    shipmentIds: [],
    deployedAt: null,
  };
}

interface Failures {
  /** Every shipment insert throws. */
  failShipment?: boolean;
  /** The next insert for this fix throws, once. */
  failShipmentOnceFor?: string;
  /** The next write-back throws, once. */
  failSetShipmentsOnce?: boolean;
}

/** An in-memory commit table and `fix_shipments` table. */
function harness(commits: RepoCommitRow[], options: Failures = {}) {
  const rows = commits.map((row) => ({ ...row }));
  const shipments: RecordFixShipmentInput[] = [];
  const fixes = new Set([FIX_A, FIX_B]);
  const failures = { ...options };
  const deps: RecordDeployDeps = {
    findCommitsBySha: async (linkId, prefix, limit) =>
      rows.filter((row) => row.repoLinkId === linkId && row.sha.startsWith(prefix)).slice(0, limit),
    listUndeployedTaggedCommits: async (linkId, maxSeq) =>
      rows
        .filter(
          (row) =>
            row.repoLinkId === linkId &&
            row.seq <= maxSeq &&
            row.fixIds.length > 0 &&
            !row.deployedAt,
        )
        .sort((a, b) => a.seq - b.seq),
    claimCommit: async (id, at) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || row.deployedAt) return false;
      row.deployedAt = at;
      return true;
    },
    releaseCommit: async (id) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row) row.deployedAt = null;
    },
    setCommitShipments: async (id, ids) => {
      if (failures.failSetShipmentsOnce) {
        failures.failSetShipmentsOnce = false;
        throw new Error("write-back failed");
      }
      const row = rows.find((candidate) => candidate.id === id);
      if (row) row.shipmentIds = ids;
    },
    loadProjectFixes: async () => (fixId) => (fixes.has(fixId) ? ({ id: fixId } as Fix) : null),
    recordFixShipment: async (input) => {
      if (failures.failShipment) throw new Error("db down");
      if (failures.failShipmentOnceFor === input.fix.id) {
        failures.failShipmentOnceFor = undefined;
        throw new Error("insert failed");
      }
      shipments.push(input);
      const row = { id: `s${shipments.length}`, version: input.version } as FixShipmentRow;
      return { row, source: {} as never, self: {} as never };
    },
    findShipment: async (projectId, fixId, version) => {
      const index = shipments.findIndex(
        (row) => row.projectId === projectId && row.fix.id === fixId && row.version === version,
      );
      return index === -1 ? null : `s${index + 1}`;
    },
    now: () => new Date("2026-11-18T12:00:00Z"),
  };
  return { deps, rows, shipments };
}

const SHA = (char: string) => char.repeat(40);

test("ships every undeployed tagged commit at or before the sha, and none after it", async () => {
  const { deps, rows, shipments } = harness([
    commit(1, SHA("a"), [FIX_A]),
    commit(2, SHA("b")),
    commit(3, SHA("c"), [FIX_B]),
    commit(4, SHA("d"), [FIX_A]),
  ]);
  const result = await recordDeploy(LINK, SHA("c"), "deployment_status", deps);
  assert.deepEqual(result, { shipped: 2, commits: 2 });
  assert.deepEqual(
    shipments.map((s) => [s.fix.id, s.version, s.notes, s.shippedBy, s.surface]),
    [
      [FIX_A, SHA("c"), "commit 1", "github:9", "github"],
      [FIX_B, SHA("c"), "commit 3", "github:9", "github"],
    ],
  );
  assert.deepEqual(shipments[0].actor, { distinctId: "github:9", projectId: PROJECT });
  assert.deepEqual(
    rows.map((row) => row.shipmentIds),
    [["s1"], [], ["s2"], []],
  );
  assert.equal(rows[3].deployedAt, null);
});

test("a second recordDeploy of the same sha records nothing", async () => {
  const { deps, shipments } = harness([commit(1, SHA("a"), [FIX_A]), commit(2, SHA("b"), [FIX_B])]);
  await recordDeploy(LINK, SHA("b"), "deployment_status", deps);
  const again = await recordDeploy(LINK, SHA("b"), "service_version", deps);
  assert.deepEqual(again, { shipped: 0, commits: 0 });
  assert.equal(shipments.length, 2);
});

test("a 7-character prefix matches its commit", async () => {
  const { deps, shipments } = harness([commit(1, `abcdef1${"0".repeat(33)}`, [FIX_A])]);
  const result = await recordDeploy(LINK, "ABCDEF1", "service_version", deps);
  assert.equal(result.shipped, 1);
  assert.equal(shipments[0].version, `abcdef1${"0".repeat(33)}`);
});

test("an ambiguous prefix, a short one or a non-sha matches nothing", async () => {
  const { deps, shipments } = harness([
    commit(1, `abcdef1${"0".repeat(33)}`, [FIX_A]),
    commit(2, `abcdef1${"1".repeat(33)}`, [FIX_B]),
  ]);
  assert.deepEqual(await recordDeploy(LINK, "abcdef1", "service_version", deps), {
    shipped: 0,
    commits: 0,
  });
  assert.deepEqual(await recordDeploy(LINK, "abcdef", "service_version", deps), {
    shipped: 0,
    commits: 0,
  });
  assert.deepEqual(await recordDeploy(LINK, "v1.2.3", "service_version", deps), {
    shipped: 0,
    commits: 0,
  });
  assert.equal(shipments.length, 0);
});

test("an unknown sha records nothing", async () => {
  const { deps, shipments } = harness([commit(1, SHA("a"), [FIX_A])]);
  assert.deepEqual(await recordDeploy(LINK, SHA("f"), "deployment_status", deps), {
    shipped: 0,
    commits: 0,
  });
  assert.equal(shipments.length, 0);
});

test("a fix that is gone ships nothing, and its commit is handled", async () => {
  const { deps, rows, shipments } = harness([commit(1, SHA("a"), [FIX_GONE, FIX_A])]);
  assert.deepEqual(await recordDeploy(LINK, SHA("a"), "deployment_status", deps), {
    shipped: 1,
    commits: 1,
  });
  assert.deepEqual(
    shipments.map((s) => s.fix.id),
    [FIX_A],
  );
  assert.notEqual(rows[0].deployedAt, null);
  assert.deepEqual(await recordDeploy(LINK, SHA("a"), "deployment_status", deps), {
    shipped: 0,
    commits: 0,
  });
});

test("one-shipment-per-fix: one fix named by two commits of one deploy ships once", async () => {
  const { deps, rows, shipments } = harness([
    commit(1, SHA("a"), [FIX_A]),
    commit(2, SHA("b"), [FIX_A]),
  ]);
  assert.deepEqual(await recordDeploy(LINK, SHA("b"), "deployment_status", deps), {
    shipped: 1,
    commits: 2,
  });
  assert.equal(shipments.length, 1);
  assert.deepEqual(
    rows.map((row) => row.shipmentIds),
    [["s1"], ["s1"]],
  );
});

test("a failed shipment releases the commit, so the next signal tries again", async () => {
  const { deps, rows } = harness([commit(1, SHA("a"), [FIX_A])], { failShipment: true });
  await assert.rejects(recordDeploy(LINK, SHA("a"), "deployment_status", deps), /db down/);
  assert.equal(rows[0].deployedAt, null);
});

/* ---------------- RC-994: a replay after a partial write ---------------- */

test("the write-back fails after the insert: a replay stores no second shipment and the commit ends with its id", async () => {
  const { deps, rows, shipments } = harness([commit(1, SHA("a"), [FIX_A])], {
    failSetShipmentsOnce: true,
  });
  await assert.rejects(
    recordDeploy(LINK, SHA("a"), "deployment_status", deps),
    /write-back failed/,
  );
  assert.equal(shipments.length, 1);
  assert.equal(rows[0].deployedAt, null, "the claim is released");

  assert.deepEqual(await recordDeploy(LINK, SHA("a"), "deployment_status", deps), {
    shipped: 0,
    commits: 1,
  });
  assert.equal(shipments.length, 1);
  assert.deepEqual(rows[0].shipmentIds, ["s1"]);
  assert.notEqual(rows[0].deployedAt, null);
});

test("a commit with two fixes fails on the second: it keeps the first, and a replay stores only the missing one", async () => {
  const { deps, rows, shipments } = harness([commit(1, SHA("a"), [FIX_A, FIX_B])], {
    failShipmentOnceFor: FIX_B,
  });
  await assert.rejects(recordDeploy(LINK, SHA("a"), "deployment_status", deps), /insert failed/);
  assert.deepEqual(rows[0].shipmentIds, ["s1"], "the finished fix is written back");

  assert.deepEqual(await recordDeploy(LINK, SHA("a"), "deployment_status", deps), {
    shipped: 1,
    commits: 1,
  });
  assert.deepEqual(
    shipments.map((row) => row.fix.id),
    [FIX_A, FIX_B],
  );
  assert.deepEqual(rows[0].shipmentIds, ["s1", "s2"]);
});

for (const [first, second] of [
  ["deployment_status", "service_version"],
  ["service_version", "deployment_status"],
] as const) {
  test(`one-shipment-per-fix: ${first} fails after its inserts, ${second} replays, one shipment per fix`, async () => {
    const { deps, rows, shipments } = harness(
      [commit(1, SHA("a"), [FIX_A]), commit(2, SHA("b"), [FIX_B])],
      { failSetShipmentsOnce: true },
    );
    await assert.rejects(recordDeploy(LINK, SHA("b"), first, deps));
    await recordDeploy(LINK, SHA("b"), second, deps);
    assert.deepEqual(await recordDeploy(LINK, SHA("b"), first, deps), { shipped: 0, commits: 0 });
    assert.deepEqual(shipments.map((row) => row.fix.id).sort(), [FIX_A, FIX_B].sort());
    assert.deepEqual(
      rows.map((row) => row.shipmentIds),
      [["s1"], ["s2"]],
    );
  });
}
