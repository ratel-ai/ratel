import type { Logger } from "pino";
import type { z } from "zod";
import type { McpAuthContext } from "@/lib/mcp/auth";

/**
 * The internal operation registry behind the MCP tools.
 *
 * Every capability is an `McpOperation`, and `lib/mcp/server.ts` publishes each
 * one as its own MCP tool. An earlier revision put three meta-tools in front of
 * this registry (`search_operations` / `execute_operation`) to keep the schema
 * cost down; that trade was made deliberately and then reversed, because thirty
 * tools is an ordinary number for a client to render and a model to choose
 * from, and the indirection cost a round trip per call. The measured price of
 * going flat is about 11k tokens of schema in every prompt, near the 8-10k the
 * old design predicted.
 *
 * The registry survived the change: it is what makes the contract test and a
 * single dispatch pipeline possible, whatever façade sits in front of it.
 */
export type OperationDomain =
  | "scope"
  | "catalog"
  | "observability"
  | "improvement"
  | "account"
  | "joins"
  | "writes";

export const OPERATION_DOMAINS: readonly OperationDomain[] = [
  "scope",
  "catalog",
  "observability",
  "improvement",
  "account",
  "joins",
  "writes",
];

/** What the operation needs resolved and authorized before it runs. */
export type OperationScope = "project" | "organization" | "none";

export interface OperationContext {
  auth: McpAuthContext;
  /**
   * The authorized project. Empty string only for `scope: "none"` operations,
   * which must not read it.
   */
  projectId: string;
  organizationId: string | null;
  logger: Logger;
}

export interface OperationResult {
  /** JSON-serializable payload, already summarized and capped. */
  data: unknown;
  /** True when any row cap or body truncation was applied anywhere in `data`. */
  truncated?: boolean;
  /** The bounded range actually queried, when the operation is windowed. */
  window?: { since: string; until: string };
  /** Drill-down guidance for the agent, e.g. which operation to call next. */
  hint?: string;
}

// A zod object schema whose parsed output is an object. Deliberately loose in
// the type parameter so operation modules can declare precise schemas without
// fighting variance at the registry boundary.
type AnyParamsSchema = z.ZodType<Record<string, unknown>>;

export interface McpOperation<Schema extends AnyParamsSchema = AnyParamsSchema> {
  /** snake_case, unique across the registry. */
  id: string;
  domain: OperationDomain;
  title: string;
  /** One or two sentences. Keyword-rich: `search_operations` matches on it. */
  description: string;
  /** Extra discovery terms that do not belong in the prose description. */
  keywords?: readonly string[];
  scope: OperationScope;
  /**
   * Whether the operation changes state. Every operation declares this
   * explicitly (the contract test enforces it) so write access can be filtered
   * mechanically rather than by reading each implementation.
   */
  mutates: boolean;
  params: Schema;
  execute(ctx: OperationContext, params: z.infer<Schema>): Promise<OperationResult>;
}

/**
 * Declare an operation with its params type inferred from its schema.
 *
 * Written inline in an `McpOperation[]` the schema widens to the default and
 * `execute` receives `Record<string, unknown>`, which throws away exactly the
 * type safety the zod schema exists to provide. Going through this helper lets
 * TypeScript infer `Schema` from `params` and type `execute`'s second argument
 * accordingly. The widening cast is confined to this one function, and it is
 * sound: dispatch only ever calls `execute` with output of that same `params`
 * schema.
 */
export function defineOperation<Schema extends AnyParamsSchema>(
  operation: McpOperation<Schema>,
): McpOperation {
  return operation as unknown as McpOperation;
}

export type Registry = ReadonlyMap<string, McpOperation>;

/**
 * Freeze the operation list into a lookup map, rejecting duplicate ids.
 *
 * A duplicate id would mean one operation silently shadows another. That kind
 * of failure shows up as an agent getting plausible answers from the wrong
 * query, so it throws at module load rather than at call time.
 */
export function buildRegistry(operations: readonly McpOperation[]): Registry {
  const map = new Map<string, McpOperation>();
  for (const operation of operations) {
    if (map.has(operation.id)) {
      throw new Error(`Duplicate MCP operation id: ${operation.id}`);
    }
    map.set(operation.id, operation);
  }
  return map;
}

export function listOperations(registry: Registry): readonly McpOperation[] {
  return [...registry.values()];
}
