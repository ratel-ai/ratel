import { afterEach, describe, expect, it } from "vitest";
import { CloudApiError, CloudClient } from "./index.js";
import { type MockCloud, startMockCloud } from "./testing/mock-cloud.js";
import type { Suggestion } from "./types.js";

let mock: MockCloud;

afterEach(async () => {
  await mock?.close();
});

function suggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: "sug-1",
    projectId: "proj-1",
    type: "edit_skill",
    signalKind: "surfaced_not_invoked",
    status: "pending",
    rationale: "description never matches how users ask",
    evidence: { skillId: "api-design", searchAppearances: 12, queries: ["make a changelog"] },
    targetSkillId: "api-design",
    targetSkillExpectedVersion: 3,
    sourceQueryIntentId: null,
    patch: { description: "sharper description" },
    retrievabilityPreview: {
      queries: ["make a changelog"],
      before: [{ query: "make a changelog", rank: null, score: null }],
      after: [{ query: "make a changelog", rank: 1, score: 4.2 }],
    },
    createdSkillId: null,
    model: "claude-sonnet-5",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    reviewedAt: null,
    appliedAt: null,
    ...overrides,
  };
}

function client(): CloudClient {
  return new CloudClient({ baseUrl: mock.url, apiKey: mock.apiKey });
}

describe("CloudClient.suggestions", () => {
  it("lists with status/type filters and a limit", async () => {
    mock = await startMockCloud();
    mock.suggestions.push(
      suggestion(),
      suggestion({ id: "sug-2", type: "new_skill", status: "approved" }),
    );

    const all = await client().suggestions.list();
    expect(all.count).toBe(2);

    const pending = await client().suggestions.list({ status: "pending" });
    expect(pending.suggestions.map((s) => s.id)).toEqual(["sug-1"]);

    const newSkills = await client().suggestions.list({ type: "new_skill", limit: 1 });
    expect(newSkills.suggestions.map((s) => s.id)).toEqual(["sug-2"]);
  });

  it("gets a suggestion by id; unknown ids map to a not_found CloudApiError", async () => {
    mock = await startMockCloud();
    mock.suggestions.push(suggestion());

    const got = await client().suggestions.get("sug-1");
    expect(got.rationale).toContain("never matches");
    expect(got.retrievabilityPreview?.after[0]?.rank).toBe(1);

    await expect(client().suggestions.get("ghost")).rejects.toSatisfy(
      (err) => err instanceof CloudApiError && err.status === 404 && err.code === "not_found",
    );
  });

  it("approves a pending suggestion; a second approve maps to a 409 conflict", async () => {
    mock = await startMockCloud();
    mock.suggestions.push(suggestion());
    const c = client();

    const approved = await c.suggestions.approve("sug-1");
    expect(approved.status).toBe("approved");

    await expect(c.suggestions.approve("sug-1")).rejects.toSatisfy(
      (err) => err instanceof CloudApiError && err.status === 409 && err.code === "conflict",
    );
  });

  it("rejects a pending suggestion with an optional reason", async () => {
    mock = await startMockCloud();
    mock.suggestions.push(suggestion());

    const rejected = await client().suggestions.reject("sug-1", { reason: "not our domain" });
    expect(rejected.status).toBe("rejected");
    const post = mock.requests.find((r) => r.path === "/api/v1/suggestions/sug-1/reject");
    expect((post?.body as Record<string, unknown>)?.reason).toBe("not our domain");
  });

  it("generate() enqueues and returns the job handle", async () => {
    mock = await startMockCloud();
    const result = await client().suggestions.generate();
    expect(result.jobId).toBe("job-1");
    expect(typeof result.coalesced).toBe("boolean");
  });
});
