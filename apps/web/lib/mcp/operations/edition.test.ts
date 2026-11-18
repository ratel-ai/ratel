import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { EditionMcpOperation, Registration } from "@/lib/contracts/registry";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { assembleOperations } from "@/lib/mcp/operations";
import {
  type AccountOperationDeps,
  accountOperations,
  defaultAccountDeps,
} from "@/lib/mcp/operations/account";
import {
  adaptEditionOperations,
  editionToolListed,
  placeEditionOperations,
} from "@/lib/mcp/operations/edition";
import { buildRegistry } from "@/lib/mcp/registry";
import { stageMeta, toolStage } from "@/lib/mcp/stages";

/**
 * Tools an edition adds through `Registration.mcpOperations`: read-only, placed after the core
 * tool they name, with the core's `projectId` and dispatch. A bad one stops startup, so every
 * rejection is pinned here.
 */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const quiet = { warn: () => {}, error: () => {}, info: () => {} } as never;

const auth: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: "org-1", slug: "acme", effectivePlan: "pro" },
};

function tool<P extends z.ZodObject>(
  patch: Partial<EditionMcpOperation<P>> & { params?: P } = {},
): EditionMcpOperation {
  return {
    id: "get_widget_usage",
    title: "Widget usage",
    description: "Widget requests and spend over a window, for the edition's own widget product.",
    keywords: ["widgets"],
    scope: "project",
    stage: null,
    params: z.object({ windowDays: z.number().int().min(1).max(90).default(30) }),
    execute: async ({ projectId, organizationId }, params) => ({
      data: { context: { projectId, organizationId }, params },
    }),
    ...patch,
  } as EditionMcpOperation;
}

function registrations(...operations: EditionMcpOperation[]): Registration[] {
  return [{ jobs: {} }, { mcpOperations: operations }];
}

const core = assembleOperations({}, []);
const ids = (operations: readonly { id: string }[]) => operations.map((operation) => operation.id);

test("without an edition the tool list is the core's", () => {
  assert.deepEqual(ids(assembleOperations()), ids(core));
  assert.deepEqual(ids(assembleOperations({}, [{ jobs: {} }])), ids(core));
});

test("an edition tool is listed right after its anchor, in registration order", () => {
  const listed = assembleOperations(
    {},
    registrations(
      tool({ id: "get_widget_usage", after: "get_quota_status" }),
      tool({ id: "get_gadget_usage", keywords: [], after: "get_quota_status" }),
      tool({ id: "get_sprocket_usage", keywords: [], after: "list_api_keys" }),
    ),
  );
  const at = (id: string) => ids(listed).indexOf(id);

  assert.equal(at("get_widget_usage"), at("get_quota_status") + 1);
  assert.equal(at("get_gadget_usage"), at("get_quota_status") + 2);
  assert.equal(at("get_sprocket_usage"), at("list_api_keys") + 1);
  assert.equal(listed.length, core.length + 3);
});

test("an edition tool with no anchor is listed last", () => {
  const listed = assembleOperations({}, registrations(tool()));
  assert.equal(ids(listed).at(-1), "get_widget_usage");
});

test("an edition tool is read-only and survives a read-only assembly", () => {
  const [placed] = adaptEditionOperations(registrations(tool({ scope: "organization" })), core);
  assert.equal(placed?.operation.mutates, false);
  assert.equal(placed?.operation.scope, "organization");
  assert.equal(placed?.operation.domain, "account");

  const readOnly = assembleOperations({ includeWrites: false }, registrations(tool()));
  assert.ok(ids(readOnly).includes("get_widget_usage"));
});

test("the core adds projectId to the edition's params, first, as on its own tools", () => {
  const [placed] = adaptEditionOperations(registrations(tool()), core);
  const schema = z.toJSONSchema(placed?.operation.params as z.ZodType, { io: "input" }) as {
    properties: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(schema.properties), ["projectId", "windowDays"]);
});

test("dispatch resolves the project, applies defaults and hands over the edition's params only", async () => {
  const operations = placeEditionOperations(
    core,
    adaptEditionOperations(registrations(tool()), core),
  );
  const result = await dispatchOperation(
    "get_widget_usage",
    { projectId: PROJECT },
    {
      registry: buildRegistry(operations),
      auth,
      projectOwner: async () => ({ organizationId: "org-1" }),
      logger: quiet,
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((result as { data: unknown }).data, {
    context: { projectId: PROJECT, organizationId: "org-1" },
    params: { windowDays: 30 },
  });
});

test("the edition's not found is the core's", async () => {
  const operations = placeEditionOperations(
    core,
    adaptEditionOperations(
      registrations(
        tool({
          execute: async (context) => {
            throw context.notFound("organization");
          },
        }),
      ),
      core,
    ),
  );
  const result = await dispatchOperation(
    "get_widget_usage",
    { projectId: PROJECT },
    {
      registry: buildRegistry(operations),
      auth,
      projectOwner: async () => ({ organizationId: "org-1" }),
      logger: quiet,
    },
  );
  assert.deepEqual(result, { ok: false, error: "not_found", message: "No organization found." });
});

test("an invalid param is refused before the edition's code runs", async () => {
  let ran = false;
  const operations = placeEditionOperations(
    core,
    adaptEditionOperations(
      registrations(
        tool({
          execute: async () => {
            ran = true;
            return { data: null };
          },
        }),
      ),
      core,
    ),
  );
  const result = await dispatchOperation(
    "get_widget_usage",
    { projectId: PROJECT, windowDays: 400 },
    {
      registry: buildRegistry(operations),
      auth,
      projectOwner: async () => ({ organizationId: "org-1" }),
      logger: quiet,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(ran, false);
});

const REJECTIONS: Array<[string, EditionMcpOperation[], RegExp]> = [
  ["an id a core tool has", [tool({ id: "get_quota_status" })], /get_quota_status.*taken/],
  ["the same id twice", [tool(), tool({ keywords: [] })], /get_widget_usage.*taken/],
  ["whoami", [tool({ id: "whoami" })], /whoami.*taken/],
  ["an id that is not snake_case", [tool({ id: "getWidgetUsage" })], /snake_case/],
  ["a short description", [tool({ description: "Widgets." })], /description/],
  ["a long description", [tool({ description: "w".repeat(401) })], /description/],
  ["an empty title", [tool({ title: "" })], /title/],
  ["its own projectId", [tool({ params: z.object({ projectId: z.string() }) })], /projectId/],
  [
    "a keyword a core tool owns",
    [tool({ keywords: ["widgets", "plan limit"] })],
    /"plan limit".*get_quota_status/,
  ],
  ["an anchor that is no core tool", [tool({ after: "get_nothing" })], /get_nothing/],
  [
    "an unknown stage",
    [tool({ stage: "deploy" as unknown as EditionMcpOperation["stage"] })],
    /stage/,
  ],
  [
    "an unknown scope",
    [tool({ scope: "none" as unknown as EditionMcpOperation["scope"] })],
    /scope/,
  ],
];

for (const [name, operations, message] of REJECTIONS) {
  test(`an edition tool is refused for ${name}`, () => {
    assert.throws(() => assembleOperations({}, registrations(...operations)), message);
  });
}

test("an edition tool's stage is published as a core tool's is", () => {
  const listed = registrations(
    tool({ stage: "monitor" }),
    tool({ id: "get_gadget_usage", keywords: [] }),
  );
  assert.equal(toolStage("get_widget_usage", listed), "monitor");
  assert.deepEqual(stageMeta("get_widget_usage", listed), { "sh.ratel/stage": "monitor" });
  assert.equal(toolStage("get_gadget_usage", listed), null);
  assert.deepEqual(stageMeta("get_gadget_usage", listed), {});
  assert.equal(toolStage("get_project_overview", listed), "monitor");
  assert.equal(toolStage("get_widget_usage"), null, "nothing is listed without an edition");
});

test("whether an edition tool is listed", () => {
  assert.equal(editionToolListed("get_widget_usage", registrations(tool())), true);
  assert.equal(editionToolListed("get_widget_usage", [{ jobs: {} }]), false);
  assert.equal(editionToolListed("get_widget_usage"), false);
});

/* ------------------------- the quota tool's pointer ------------------------ */

async function quotaHint(listed: boolean): Promise<string | undefined> {
  const deps: AccountOperationDeps = {
    ...defaultAccountDeps,
    getOrganizationByProjectId: async () => ({ id: "org-1", slug: "acme", plan: "free" }) as never,
    countSkills: async () => 0,
    countMemberships: async () => 1,
    listProjectsForOrganization: async () => [],
    editionToolListed: (id) => listed && id === "get_embedding_usage",
  };
  const result = await dispatchOperation(
    "get_quota_status",
    { projectId: PROJECT },
    {
      registry: buildRegistry(accountOperations(deps)),
      auth,
      projectOwner: async () => ({ organizationId: "org-1" }),
      logger: quiet,
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { hint?: string }).hint;
}

test("get_quota_status points at get_embedding_usage when the edition lists it", async () => {
  assert.equal(
    await quotaHint(true),
    "get_embedding_usage shows the Embeddings and Tool Picker wallets.",
  );
});

test("get_quota_status names no tool the caller does not have", async () => {
  assert.equal(await quotaHint(false), undefined);
  assert.equal(defaultAccountDeps.editionToolListed("get_embedding_usage"), false);
});
