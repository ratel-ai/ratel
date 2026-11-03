import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import { type RuntimeWriteDeps, runtimeWriteOperations } from "./writes-runtime";

/**
 * The searchable-description override, which is the one write here that a
 * project key cannot already perform over HTTP. Its own file comment argues why
 * that is acceptable; these tests pin the two properties that argument rests on:
 * the change is reversible by passing null, and an entry the runtime never
 * synced reads as absent rather than as a clue.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

interface TrackedEvent {
  name: string;
  properties: Record<string, unknown>;
}

function deps(events: TrackedEvent[], overrides: Partial<RuntimeWriteDeps> = {}): RuntimeWriteDeps {
  return {
    setRuntimeCatalogOverride: async (_projectId, _kind, _entryId, description) => ({
      searchableDescriptionOverride: description,
    }),
    trackServerEvent: (async (
      name: string,
      _context: unknown,
      properties: Record<string, unknown>,
    ) => {
      events.push({ name, properties });
    }) as RuntimeWriteDeps["trackServerEvent"],
    ...overrides,
  };
}

function run(
  params: Record<string, unknown>,
  options: { events?: TrackedEvent[] } & Partial<RuntimeWriteDeps> = {},
) {
  const { events = [], ...overrides } = options;
  return dispatchOperation("set_catalog_override", params, {
    registry: buildRegistry(runtimeWriteOperations(deps(events, overrides))),
    auth,
  });
}

test("setting an override returns the text now in effect", async () => {
  const result = await run({
    kind: "tool",
    entryId: "http_post",
    searchableDescription: "Send a JSON body to a URL over HTTP POST.",
  });

  assert.equal(result.ok, true);
  assert.deepEqual((result as { data: unknown }).data, {
    kind: "tool",
    entryId: "http_post",
    searchableDescription: "Send a JSON body to a URL over HTTP POST.",
  });
});

test("null clears the override rather than storing the word null", async () => {
  const events: TrackedEvent[] = [];
  const result = await run(
    { kind: "tool", entryId: "http_post", searchableDescription: null },
    { events },
  );

  assert.equal(result.ok, true);
  assert.equal(
    (result as { data: { searchableDescription: string | null } }).data.searchableDescription,
    null,
  );
  assert.equal(events[0]?.properties.cleared, true);
});

test("the change emits the same business event the console route emits", async () => {
  const events: TrackedEvent[] = [];
  await run({ kind: "skill", entryId: "refund-policy", searchableDescription: "text" }, { events });

  const [event] = events;
  assert.equal(event?.name, "runtime_catalog_override_updated");
  assert.equal(event?.properties.object_action, "runtime_catalog_override_updated");
  assert.equal(event?.properties.kind, "skill");
  assert.equal(
    event?.properties.surface,
    "mcp",
    "MCP writes must be separable from console writes",
  );
});

test("an entry the runtime never synced is not found, and nothing is tracked", async () => {
  const events: TrackedEvent[] = [];
  const result = await run(
    { kind: "tool", entryId: "never-seen", searchableDescription: "text" },
    { events, setRuntimeCatalogOverride: async () => null },
  );

  assert.equal(result.ok === false && result.error, "not_found");
  assert.equal(events.length, 0, "a write that did not happen must not be reported as one");
});

test("an unknown catalog kind is refused before any write", async () => {
  let wrote = false;
  const result = await run(
    { kind: "gadget", entryId: "http_post", searchableDescription: "text" },
    {
      setRuntimeCatalogOverride: async () => {
        wrote = true;
        return { searchableDescriptionOverride: "text" };
      },
    },
  );

  assert.equal(result.ok === false && result.error, "invalid_params");
  assert.equal(wrote, false);
});
