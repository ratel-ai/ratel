import { accountOperations } from "@/lib/mcp/operations/account";
import { calibrationOperations } from "@/lib/mcp/operations/calibration";
import { catalogOperations } from "@/lib/mcp/operations/catalog";
import { improvementOperations } from "@/lib/mcp/operations/improvement";
import { joinsOperations } from "@/lib/mcp/operations/joins";
import { loopReadOperations, loopWriteOperations } from "@/lib/mcp/operations/loop";
import { observabilityOperations } from "@/lib/mcp/operations/observability";
import { playgroundOperations } from "@/lib/mcp/operations/playground";
import { scopeOperations } from "@/lib/mcp/operations/scope";
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
   * The improvement-loop tools (`lib/mcp/operations/loop`), behind
   * `FF_MCP_LOOP`. Defaults to true so the contract tests see the whole
   * surface; the route passes the caller's flag decision.
   */
  includeLoop?: boolean;
}

export function assembleOperations(options: AssembleOptions = {}): McpOperation[] {
  const includeWrites = options.includeWrites ?? true;
  const includeLoop = options.includeLoop ?? true;
  return [
    ...scopeOperations(),
    ...catalogOperations(),
    ...observabilityOperations(),
    ...calibrationOperations(),
    ...improvementOperations(),
    ...toolExplorerOperations(),
    ...toolCrafterOperations(),
    ...accountOperations(),
    ...joinsOperations(),
    ...playgroundOperations(),
    ...(includeLoop ? loopReadOperations() : []),
    ...(includeWrites
      ? [...writeOperations(), ...runtimeWriteOperations(), ...toolCrafterWriteOperations()]
      : []),
    ...(includeWrites && includeLoop ? loopWriteOperations() : []),
  ];
}

/** Build a registry for one request. */
export function buildRequestRegistry(options: AssembleOptions = {}): Registry {
  return buildRegistry(assembleOperations(options));
}
