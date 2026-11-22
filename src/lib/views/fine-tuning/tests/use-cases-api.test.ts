import assert from "node:assert/strict";
import { test } from "node:test";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import type { UseCase } from "../domain/use-case";
import type { UseCaseStore } from "../ports/store";
import {
  handleUseCaseRequest,
  handleUseCasesRequest,
  type UseCaseApiDeps,
  type UseCaseEvent,
} from "../use-cases-api";

/** RC-1124: members create, update and archive use cases; a bad selector is refused with its code. */

const PROJECT = { id: "p1", organizationId: "org-1" } as Project;
const ORGANIZATION = { id: "org-1", slug: "acme" } as Organization;
const ID = "55555555-5555-4555-8555-555555555555";

function harness(overrides: Partial<UseCaseApiDeps> = {}) {
  const rows = new Map<string, UseCase>();
  const tracked: UseCaseEvent[] = [];
  const store: UseCaseStore = {
    listUseCases: async () => [...rows.values()],
    getUseCase: async (_projectId, id) => rows.get(id) ?? null,
    createUseCase: async (projectId, input, actor) => {
      if ([...rows.values()].some((row) => row.name === input.name))
        return { ok: false, reason: "name_taken" };
      const useCase = {
        id: ID,
        projectId,
        ...input,
        createdBy: actor,
        createdAt: new Date("2026-11-20T00:00:00Z"),
        archivedAt: null,
      };
      rows.set(ID, useCase);
      return { ok: true, useCase };
    },
    updateUseCase: async (_projectId, id, patch) => {
      const row = rows.get(id);
      if (!row) return { ok: false, reason: "not_found" };
      const useCase = {
        ...row,
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.selector ? { selector: patch.selector } : {}),
      };
      rows.set(id, useCase);
      return { ok: true, useCase };
    },
    archiveUseCase: async (_projectId, id) => {
      const row = rows.get(id);
      if (!row) return { ok: false, reason: "not_found" };
      rows.delete(id);
      return { ok: true, useCase: { ...row, archivedAt: new Date() } };
    },
  };
  const deps: UseCaseApiDeps = {
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async () => ({
      project: PROJECT,
      organization: ORGANIZATION,
      role: "member",
    }),
    fineTuningEnabled: async () => true,
    isRestricted: async () => false,
    store: () => store,
    track: async (event) => {
      tracked.push(event);
    },
    ...overrides,
  };
  const request = (method: string, body?: unknown) =>
    new Request("http://x", {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    collection: (method: string, body?: unknown) =>
      handleUseCasesRequest(request(method, body), "p1", deps),
    item: (method: string, body?: unknown, id = ID) =>
      handleUseCaseRequest(request(method, body), "p1", id, deps),
    rows,
    tracked,
  };
}

test("a member creates a use case for one task, lists it, renames it and archives it, with one event each", async () => {
  const { collection, item, tracked } = harness();
  const created = await collection("POST", { name: " Triage ", selector: { taskIds: ["triage"] } });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).useCase.selector, { taskIds: ["triage"], intentIds: [] });
  assert.deepEqual(
    (await (await collection("GET")).json()).useCases.map((row: { name: string }) => row.name),
    ["Triage"],
  );
  assert.equal(
    (await (await item("PATCH", { name: "Triage v2" })).json()).useCase.name,
    "Triage v2",
  );
  assert.equal((await item("DELETE")).status, 200);
  assert.equal((await item("GET")).status, 404);
  assert.deepEqual(
    tracked.map((event) => [event.name, event.externalId]),
    [
      ["use_case_created", "user_1"],
      ["use_case_updated", "user_1"],
      ["use_case_archived", "user_1"],
    ],
  );
});

test("an unknown key or an empty selector is refused with its typed error, and nothing is written", async () => {
  const { collection, item, rows, tracked } = harness();
  const cases: [unknown, string][] = [
    [{ name: "A", selector: { taskIds: ["t"], variant: "x" } }, "unknown_key"],
    [{ name: "A", selector: {} }, "empty_selector"],
    [{ name: "A", selector: { intentIds: ["nope"] } }, "invalid_selector"],
    [{ name: "", selector: { taskIds: ["t"] } }, "invalid"],
    [{ name: "A", selector: { taskIds: ["t"] }, extra: 1 }, "unknown_key"],
  ];
  for (const [body, error] of cases) {
    const response = await collection("POST", body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, error, JSON.stringify(body));
  }
  assert.equal((await item("PATCH", { selector: { taskIds: [] } })).status, 400);
  assert.equal(rows.size, 0);
  assert.deepEqual(tracked, []);
});

test("a taken name is 409; an unknown use case is 404", async () => {
  const { collection, item } = harness();
  await collection("POST", { name: "Triage", selector: { taskIds: ["t"] } });
  const again = await collection("POST", { name: "Triage", selector: { taskIds: ["t"] } });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, "name_taken");
  assert.equal(
    (await item("DELETE", undefined, "66666666-6666-4666-8666-666666666666")).status,
    404,
  );
});

test("signed out, not a member, flag off or a support session write nothing", async () => {
  const cases: [Partial<UseCaseApiDeps>, string, number][] = [
    [{ getSession: async () => null }, "GET", 401],
    [{ findProjectScope: async () => null }, "GET", 404],
    [{ fineTuningEnabled: async () => false }, "GET", 404],
    [{ fineTuningEnabled: async () => false }, "POST", 404],
    [{ isRestricted: async () => true }, "POST", 403],
  ];
  for (const [deps, method, status] of cases) {
    const { collection, rows } = harness(deps);
    assert.equal(
      (
        await collection(
          method,
          method === "POST" ? { name: "A", selector: { taskIds: ["t"] } } : undefined,
        )
      ).status,
      status,
    );
    assert.equal(rows.size, 0);
  }
});
