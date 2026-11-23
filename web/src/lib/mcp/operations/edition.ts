import { z } from "zod";
import { composition } from "@/lib/composition/ports";
import type { EditionMcpOperation, McpToolStage, Registration } from "@/lib/contracts/registry";
import { notFound } from "@/lib/mcp/errors";
import { ROUTING_KEYWORDS } from "@/lib/mcp/naming";
import { projectScoped } from "@/lib/mcp/operations/params";
import type { McpOperation } from "@/lib/mcp/registry";
import type { LineageStage } from "@/lib/views/lineage/types";

/**
 * MCP tools an edition adds through `Registration.mcpOperations` (`lib/contracts/registry.ts`),
 * over data only the edition holds, such as Cloud's wallets and API usage. This module turns
 * each into a core `McpOperation`: read-only (`mutates: false`), in the `account` domain, with
 * the core's `projectId` param ahead of its own, so dispatch resolves and authorizes the
 * project exactly as for a core tool. `assembleOperations` lists each right after the core tool
 * it names in `after`.
 *
 * A bad edition tool throws here, and `instrumentation.node.ts` assembles the tool list at boot,
 * so it stops startup rather than surfacing as a tool that answers wrongly. The rules are the
 * ones `contract.test.ts` and `naming.test.ts` hold the core's tools to.
 */

// The contract spells the stages out so it imports nothing; keep it equal to the core's.
type SameStages = [Exclude<McpToolStage, null>] extends [LineageStage]
  ? [LineageStage] extends [Exclude<McpToolStage, null>]
    ? true
    : never
  : never;
const sameStages: SameStages = true;
void sameStages;

const STAGES: ReadonlySet<McpToolStage> = new Set(["monitor", "insights", "improve", "ship", null]);
const SCOPES: ReadonlySet<string> = new Set(["project", "organization"]);
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;
/** The bounds `contract.test.ts` holds every description to. */
const DESCRIPTION = { min: 21, max: 400 } as const;
/** Published by the server itself, outside the registry. */
const RESERVED_IDS: readonly string[] = ["whoami"];

export interface EditionPlacement {
  operation: McpOperation;
  /** The core tool it is listed after; absent lists it last. */
  after?: string;
}

/** The edition's registrations, read through the composition (none in the open-source edition). */
export function editionRegistrations(): Registration[] {
  return composition.registry.registrations();
}

function editionTools(registrations: readonly Registration[]): EditionMcpOperation[] {
  return registrations.flatMap((registration) => registration.mcpOperations ?? []);
}

function refuse(id: string, reason: string): never {
  throw new Error(`edition MCP tool ${JSON.stringify(id)}: ${reason}`);
}

function validate(
  tool: EditionMcpOperation,
  taken: ReadonlySet<string>,
  coreIds: ReadonlySet<string>,
): void {
  const { id } = tool;
  if (!SNAKE_CASE.test(id)) refuse(id, "the id must be snake_case");
  if (taken.has(id)) refuse(id, `the id ${id} is taken`);
  if (!tool.title?.trim()) refuse(id, "the title is empty");
  const length = tool.description?.length ?? 0;
  if (length < DESCRIPTION.min || length > DESCRIPTION.max) {
    refuse(
      id,
      `the description is ${length} characters; it must be ${DESCRIPTION.min} to ${DESCRIPTION.max}`,
    );
  }
  if (!SCOPES.has(tool.scope)) refuse(id, `unknown scope ${JSON.stringify(tool.scope)}`);
  if (!STAGES.has(tool.stage)) refuse(id, `unknown stage ${JSON.stringify(tool.stage)}`);
  if (!(tool.params instanceof z.ZodObject)) refuse(id, "params must be a zod object");
  if ("projectId" in tool.params.shape) {
    refuse(id, "params must not declare projectId: the core adds it");
  }
  for (const keyword of tool.keywords ?? []) {
    const owner = ROUTING_KEYWORDS[keyword];
    if (owner && owner !== id) {
      refuse(id, `the keyword ${JSON.stringify(keyword)} is a question ${owner} owns`);
    }
  }
  if (tool.after !== undefined && !coreIds.has(tool.after)) {
    refuse(id, `after names ${tool.after}, which is no core tool`);
  }
}

function adapt(tool: EditionMcpOperation): McpOperation {
  return {
    id: tool.id,
    domain: "account",
    title: tool.title,
    description: tool.description,
    ...(tool.keywords ? { keywords: tool.keywords } : {}),
    scope: tool.scope,
    mutates: false,
    // projectId first, as `projectScoped` leads every core tool's params.
    params: z.object({ ...projectScoped, ...tool.params.shape }) as McpOperation["params"],
    async execute(context, params) {
      const { projectId: _resolved, ...own } = params;
      const result = await tool.execute(
        { projectId: context.projectId, organizationId: context.organizationId, notFound },
        own,
      );
      return {
        data: result.data,
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.hint ? { hint: result.hint } : {}),
      };
    },
  };
}

/** Validate and adapt every edition tool against the core's list; throws on the first bad one. */
export function adaptEditionOperations(
  registrations: readonly Registration[],
  core: readonly McpOperation[],
): EditionPlacement[] {
  const coreIds = new Set(core.map((operation) => operation.id));
  const taken = new Set([...coreIds, ...RESERVED_IDS]);
  return editionTools(registrations).map((tool) => {
    validate(tool, taken, coreIds);
    taken.add(tool.id);
    return { operation: adapt(tool), ...(tool.after ? { after: tool.after } : {}) };
  });
}

/** The core list with each edition tool after its anchor (in registration order), the rest last. */
export function placeEditionOperations(
  core: readonly McpOperation[],
  placements: readonly EditionPlacement[],
): McpOperation[] {
  if (placements.length === 0) return [...core];
  const out: McpOperation[] = [];
  for (const operation of core) {
    out.push(operation);
    for (const placement of placements) {
      if (placement.after === operation.id) out.push(placement.operation);
    }
  }
  for (const placement of placements) {
    if (placement.after === undefined) out.push(placement.operation);
  }
  return out;
}

/** Whether the edition lists a tool by this id, for a core tool whose hint points at it. */
export function editionToolListed(
  id: string,
  registrations: readonly Registration[] = editionRegistrations(),
): boolean {
  return editionTools(registrations).some((tool) => tool.id === id);
}

/** An edition tool's stage, or undefined when no edition tool has that id. */
export function editionToolStage(
  id: string,
  registrations: readonly Registration[] = editionRegistrations(),
): McpToolStage | undefined {
  const tool = editionTools(registrations).find((candidate) => candidate.id === id);
  return tool ? tool.stage : undefined;
}
