import type { Registration } from "@/lib/contracts/registry";
import { accountOperations } from "@/lib/mcp/operations/account";
import { agentsOperations } from "@/lib/mcp/operations/agents";
import { calibrationOperations } from "@/lib/mcp/operations/calibration";
import { catalogOperations } from "@/lib/mcp/operations/catalog";
import { clientsOperations } from "@/lib/mcp/operations/clients";
import { developerOperations } from "@/lib/mcp/operations/developer";
import {
  adaptEditionOperations,
  editionRegistrations,
  placeEditionOperations,
} from "@/lib/mcp/operations/edition";
import { experimentOperations } from "@/lib/mcp/operations/experiments";
import { healthOperations } from "@/lib/mcp/operations/health";
import { improvementOperations } from "@/lib/mcp/operations/improvement";
import { intentsOperations } from "@/lib/mcp/operations/intents";
import { joinsOperations } from "@/lib/mcp/operations/joins";
import { loopReadOperations, loopWriteOperations } from "@/lib/mcp/operations/loop";
import {
  loopEvalSetReadOperations,
  loopEvalSetWriteOperations,
} from "@/lib/mcp/operations/loop/eval-sets";
import { loopTaskReadOperations, loopTaskWriteOperations } from "@/lib/mcp/operations/loop/tasks";
import { mcpServersOperations } from "@/lib/mcp/operations/mcp-servers";
import { observabilityOperations } from "@/lib/mcp/operations/observability";
import { playgroundOperations } from "@/lib/mcp/operations/playground";
import { qualityOperations } from "@/lib/mcp/operations/quality";
import { rankingOperations } from "@/lib/mcp/operations/ranking";
import { runsOperations } from "@/lib/mcp/operations/runs";
import { scopeOperations } from "@/lib/mcp/operations/scope";
import { shipOperations } from "@/lib/mcp/operations/ship";
import {
  toolCrafterOperations,
  toolCrafterWriteOperations,
} from "@/lib/mcp/operations/tool-crafter";
import { toolExplorerOperations } from "@/lib/mcp/operations/tool-explorer";
import { writeOperations } from "@/lib/mcp/operations/writes";
import { runtimeWriteOperations } from "@/lib/mcp/operations/writes-runtime";
import { buildRegistry, type McpOperation, type Registry } from "@/lib/mcp/registry";

export interface AssembleOptions {
  /** Omit write operations, for a read-only deployment or a read-only test. */
  includeWrites?: boolean;
}

/**
 * Every console surface's tools, in the order the console's navigation lists
 * them. A module may mix reads and writes; `includeWrites: false` drops every
 * operation that declares `mutates`, which the contract test pins.
 *
 * Owned (ADR-0030): an edition's tools (`registrations`, read through the
 * composition) are listed after the core tool each names; `edition.ts` refuses
 * a bad one. The open-source edition has none, so the list is the core's.
 */
export function assembleOperations(
  options: AssembleOptions = {},
  registrations: readonly Registration[] = editionRegistrations(),
): McpOperation[] {
  const includeWrites = options.includeWrites ?? true;
  const core = [
    ...scopeOperations(),
    ...catalogOperations(),
    ...observabilityOperations(),
    ...runsOperations(),
    ...mcpServersOperations(),
    ...clientsOperations(),
    ...agentsOperations(),
    ...healthOperations(),
    ...intentsOperations(),
    ...calibrationOperations(),
    ...experimentOperations(),
    ...improvementOperations(),
    ...qualityOperations(),
    ...rankingOperations(),
    ...toolExplorerOperations(),
    ...toolCrafterOperations(),
    ...accountOperations(),
    ...developerOperations(),
    ...joinsOperations(),
    ...playgroundOperations(),
    ...shipOperations(),
    ...loopReadOperations(),
    ...loopTaskReadOperations(),
    ...loopEvalSetReadOperations(),
    ...writeOperations(),
    ...runtimeWriteOperations(),
    ...toolCrafterWriteOperations(),
    ...loopWriteOperations(),
    ...loopTaskWriteOperations(),
    ...loopEvalSetWriteOperations(),
  ];
  const operations = placeEditionOperations(core, adaptEditionOperations(registrations, core));
  return includeWrites ? operations : operations.filter((operation) => !operation.mutates);
}

/**
 * How many tools an agent is offered with `FF_MCP_APPS` off: every
 * operation but the app-only ones (registered for MCP Apps views alone), plus
 * `whoami`. The Integrations page states it; flag-off.test.ts pins it to the
 * server's own tools/list.
 */
export function agentToolCount(): number {
  return assembleOperations().filter((operation) => !operation.appOnly).length + 1;
}

/** Build a registry for one request. */
export function buildRequestRegistry(options: AssembleOptions = {}): Registry {
  return buildRegistry(assembleOperations(options));
}
