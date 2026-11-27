import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import {
  CONTENT_WITHHELD_HINT,
  contentHint,
  experimentAttributesFor,
  mayCopyContent,
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
  scopes: ["*"],
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

test("an API key without the content scope never reads captured text, even with the opt-in on (RC-585)", async () => {
  const optedIn = { contentOptIn: async () => true };
  for (const scopes of [
    ["mcp:read"],
    ["mcp:read", "mcp:write"],
    ["ingest:traces", "ingest:logs", "ingest:events"],
  ]) {
    assert.equal(
      await mayReadContent({ auth: { ...apiKey, scopes }, projectId: PROJECT }, optedIn),
      false,
      scopes.join(","),
    );
  }
  assert.equal(
    await mayReadContent(
      { auth: { ...apiKey, scopes: ["mcp:read", "content:read"] }, projectId: PROJECT },
      optedIn,
    ),
    true,
  );
});

test("every MCP tool module that reads the content opt-in also asks the credential rule (RC-585)", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory()
        ? walk(path)
        : path.endsWith(".ts") && !path.endsWith(".test.ts")
          ? [path]
          : [];
    });
  const offenders = walk(import.meta.dirname)
    .filter((file) => !file.endsWith("content-access.ts"))
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      const readsOptIn = /\bcontentOptIn\(|\breadContentOptIn\b/.test(source);
      return readsOptIn && !/\bmayReadContent\(|\bcredentialMayReadContent\(/.test(source);
    });
  assert.deepEqual(
    offenders,
    [],
    "gate captured text with mayReadContent or credentialMayReadContent",
  );
});

test("copying captured text into a row or case needs the project's opt-in, for a signed-in member too", async () => {
  const optIn = (value: boolean) => ({ contentOptIn: async () => value });
  assert.equal(await mayCopyContent({ auth: oauth, projectId: PROJECT }, optIn(false)), false);
  assert.equal(await mayCopyContent({ auth: oauth, projectId: PROJECT }, optIn(true)), true);
  assert.equal(await mayCopyContent({ auth: apiKey, projectId: PROJECT }, optIn(false)), false);
  assert.equal(await mayCopyContent({ auth: apiKey, projectId: PROJECT }, optIn(true)), true);
  const noScope = { ...apiKey, scopes: ["mcp:read" as const] };
  assert.equal(await mayCopyContent({ auth: noScope, projectId: PROJECT }, optIn(true)), false);
  const failing = {
    contentOptIn: async () => {
      throw new Error("statement timeout");
    },
  };
  assert.equal(await mayCopyContent({ auth: oauth, projectId: PROJECT }, failing), false);
});
