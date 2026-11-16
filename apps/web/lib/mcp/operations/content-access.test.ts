import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import {
  CONTENT_WITHHELD_HINT,
  contentHint,
  experimentAttributesFor,
  mayReadContent,
  withheldMarker,
} from "./content-access";

/**
 * The one rule every content-bearing tool asks: a signed-in member reads
 * captured text, an API key reads it only with the project's content opt-in,
 * and a failed opt-in read withholds rather than leaks or fails the call.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";

const apiKey: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

const oauth: McpAuthContext = {
  kind: "oauth",
  externalUserId: "user_abc",
  userId: "u-1",
  memberships: [
    {
      organizationId: "org-1",
      role: "member",
      organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
    },
  ],
};

test("an API key reads captured text only with the project's opt-in", async () => {
  const asked: string[] = [];
  const optIn = (value: boolean) => ({
    contentOptIn: async (projectId: string) => (asked.push(projectId), value),
  });
  assert.equal(await mayReadContent({ auth: apiKey, projectId: PROJECT }, optIn(false)), false);
  assert.equal(await mayReadContent({ auth: apiKey, projectId: PROJECT }, optIn(true)), true);
  assert.deepEqual(asked, [PROJECT, PROJECT]);
});

test("a signed-in member reads captured text without the opt-in being read", async () => {
  const deps = {
    contentOptIn: async () => {
      throw new Error("must not be read for a member");
    },
  };
  assert.equal(await mayReadContent({ auth: oauth, projectId: PROJECT }, deps), true);
});

test("a failed opt-in read withholds the text", async () => {
  const deps = {
    contentOptIn: async () => {
      throw new Error("statement timeout");
    },
  };
  assert.equal(await mayReadContent({ auth: apiKey, projectId: PROJECT }, deps), false);
});

test("the marker, the hint and the experiment query follow the decision", () => {
  assert.deepEqual(withheldMarker(true), {});
  assert.deepEqual(withheldMarker(false), { contentWithheld: true });
  assert.equal(contentHint(true, "next"), "next");
  assert.equal(contentHint(false, "next"), `${CONTENT_WITHHELD_HINT} next`);
  assert.equal(contentHint(false, undefined), CONTENT_WITHHELD_HINT);

  const attrs = { "ratel.experiment.query": "refund my order", "ratel.experiment.arm": "ratel" };
  assert.equal(experimentAttributesFor(attrs, true), attrs);
  assert.deepEqual(experimentAttributesFor(attrs, false), { "ratel.experiment.arm": "ratel" });
});
