import { accountOperations } from "@/lib/mcp/operations/account";
import { calibrationOperations } from "@/lib/mcp/operations/calibration";
import { catalogOperations } from "@/lib/mcp/operations/catalog";
import { improvementOperations } from "@/lib/mcp/operations/improvement";
import { joinsOperations } from "@/lib/mcp/operations/joins";
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
}

export function assembleOperations(options: AssembleOptions = {}): McpOperation[] {
  const includeWrites = options.includeWrites ?? true;
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
    ...(includeWrites
      ? [...writeOperations(), ...runtimeWriteOperations(), ...toolCrafterWriteOperations()]
      : []),
  ];
}

/** Build a registry for one request. */
export function buildRequestRegistry(options: AssembleOptions = {}): Registry {
  return buildRegistry(assembleOperations(options));
}
