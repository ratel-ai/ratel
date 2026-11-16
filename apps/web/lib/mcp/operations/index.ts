import { accountOperations } from "@/lib/mcp/operations/account";
import { calibrationOperations } from "@/lib/mcp/operations/calibration";
import { catalogOperations } from "@/lib/mcp/operations/catalog";
import { developerOperations } from "@/lib/mcp/operations/developer";
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
  /**
   * The improvement-loop tools (`lib/mcp/operations/loop`, its tasks and eval sets), behind
   * `FF_MCP_LOOP`. Defaults to true so the contract tests see the whole surface; the route
   * passes the caller's flag decision. Owned: upstream retired its flag (RC-234) and lists them
   * for everyone with app access; here they stay an experimental switch for the open-source
   * edition, which the Cloud deployments turn on.
   */
  includeLoop?: boolean;
}

/**
 * Every console surface's tools, in the order the console's navigation lists them. A module may
 * mix reads and writes; `includeWrites: false` drops every operation that declares `mutates`,
 * which the contract test pins.
 */
export function assembleOperations(options: AssembleOptions = {}): McpOperation[] {
  const includeWrites = options.includeWrites ?? true;
  const includeLoop = options.includeLoop ?? true;
  const operations = [
    ...scopeOperations(),
    ...catalogOperations(),
    ...observabilityOperations(),
    ...runsOperations(),
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
    ...(includeLoop
      ? [...loopReadOperations(), ...loopTaskReadOperations(), ...loopEvalSetReadOperations()]
      : []),
    ...writeOperations(),
    ...runtimeWriteOperations(),
    ...toolCrafterWriteOperations(),
    ...(includeLoop
      ? [...loopWriteOperations(), ...loopTaskWriteOperations(), ...loopEvalSetWriteOperations()]
      : []),
  ];
  return includeWrites ? operations : operations.filter((operation) => !operation.mutates);
}

/** Build a registry for one request. */
export function buildRequestRegistry(options: AssembleOptions = {}): Registry {
  return buildRegistry(assembleOperations(options));
}
