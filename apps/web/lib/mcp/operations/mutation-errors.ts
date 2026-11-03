import { McpOperationError, notFound } from "@/lib/mcp/errors";

/**
 * Map a v1 mutation `reason` onto the MCP taxonomy, once for every write.
 *
 * Each write used to carry its own copy of this, which is how a suggestion that
 * had already been approved would have been reported as "the skill changed
 * since you read it": the reasons are shared across entities but the messages
 * were not. One mapper means a new reason is handled everywhere the moment it
 * is handled anywhere.
 *
 * ADR-0014 makes the SDK mock server the authoritative wire contract for these
 * reasons, so each is passed through verbatim in `reason` rather than renamed.
 * The prose is ours; the machine code is theirs.
 */
export function throwMutationFailure(reason: string, entity: string): never {
  if (reason === "not_found") throw notFound(entity);
  if (reason === "wrong_type") {
    throw new McpOperationError("invalid_params", "Wrong entity type for this operation.", {
      reason,
    });
  }
  throw new McpOperationError("conflict", conflictMessage(reason, entity), { reason });
}

function conflictMessage(reason: string, entity: string): string {
  switch (reason) {
    case "not_pending":
      return `That ${entity} is no longer pending: it has already been approved or rejected.`;
    case "name_conflict":
      return "A skill with that name already exists in this project.";
    case "version_conflict":
      return `The ${entity} changed since you read it. Re-read it and retry.`;
    default:
      return `The ${entity} cannot be changed in its current state.`;
  }
}
