import assert from "node:assert/strict";
import { test } from "node:test";
import {
  memberQualityReportOffered,
  type OperatorConsole,
  qualityReportProjectId,
} from "@/lib/views/quality/operator-console";

const is404 = (err: { digest?: string }) => String(err.digest).includes("404");
const refused = () =>
  Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), {
    digest: "NEXT_HTTP_ERROR_FALLBACK;404",
  });

function operator(allows: boolean, calls: string[]): OperatorConsole {
  return {
    authorize: async () => {
      calls.push("authorize");
      if (!allows) throw refused();
    },
    Frame: () => null,
  };
}

test("without an operator console the report is a member's: the project comes from the console scope", async () => {
  const calls: string[] = [];
  const projectId = await qualityReportProjectId("requested", {
    operatorConsole: async () => undefined,
    requireProjectScope: async (id) => {
      calls.push(`scope:${id}`);
      return { project: { id: "scoped" } };
    },
  });
  assert.equal(projectId, "scoped");
  assert.deepEqual(calls, ["scope:requested"]);
});

test("without an operator console a reader outside the organization gets the scope's 404", async () => {
  await assert.rejects(
    qualityReportProjectId("elsewhere", {
      operatorConsole: async () => undefined,
      requireProjectScope: async () => {
        throw refused();
      },
    }),
    is404,
  );
});

test("with an operator console the operator opens any project's report, as upstream", async () => {
  const calls: string[] = [];
  const projectId = await qualityReportProjectId("any-tenant", {
    operatorConsole: async () => operator(true, calls),
    requireProjectScope: async () => {
      calls.push("scope");
      return { project: { id: "scoped" } };
    },
  });
  assert.equal(projectId, "any-tenant");
  assert.deepEqual(calls, ["authorize"]);
});

test("with an operator console a member is refused, even inside their own organization", async () => {
  const calls: string[] = [];
  await assert.rejects(
    qualityReportProjectId("own-project", {
      operatorConsole: async () => operator(false, calls),
      requireProjectScope: async () => {
        calls.push("scope");
        return { project: { id: "own-project" } };
      },
    }),
    is404,
  );
  assert.deepEqual(calls, ["authorize"]);
});

test("the calibration page offers members the report only when there is no operator console", async () => {
  assert.equal(await memberQualityReportOffered(async () => undefined), true);
  assert.equal(await memberQualityReportOffered(async () => operator(true, [])), false);
});
