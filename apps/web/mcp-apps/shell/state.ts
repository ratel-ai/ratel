/**
 * What a view is showing, as a pure reducer over the host's notifications, so
 * every view handles the same states the same way and the tests need no host.
 *
 *   connecting → (input-partial) → waiting → ready | error | cancelled
 *
 * A Ratel tool result is a `DispatchResult` (lib/mcp/dispatch.ts) in
 * `structuredContent`: `{ ok: true, data, truncated?, window?, hint? }`, or the
 * error body of lib/mcp/errors.ts, `{ ok: false, error, message, ... }`. The
 * view's own model rides in `_meta["sh.ratel/view"]`, out of the model's sight.
 */
import type { McpAppBinding } from "@/lib/mcp/apps/types";
import { BINDING_META_KEY, VIEW_META_KEY } from "@/lib/mcp/apps/types";

export type Theme = "light" | "dark";

export interface ToolSuccess<T = unknown> {
  ok: true;
  operation_id?: string;
  data: T;
  truncated?: boolean;
  window?: { since: string; until: string };
  hint?: string;
  /** Data only the view reads (OperationResult.view): from the result's `_meta["sh.ratel/view"]`, never its content. */
  view?: Record<string, unknown>;
}

export interface ToolFailure {
  /** An McpErrorCode, or "tool_error" when the host reports an error with no Ratel body. */
  code: string;
  message: string;
  /** Seconds, when the server said when to retry. */
  retryAfterSeconds?: number;
}

export type ViewStatus = "connecting" | "partial" | "waiting" | "ready" | "error" | "cancelled";

export interface ViewState<T = unknown> {
  status: ViewStatus;
  /** The tool's arguments, as far as they are known. */
  input: Record<string, unknown> | null;
  result: ToolSuccess<T> | null;
  error: ToolFailure | null;
  /** Why the call was cancelled, when the host said. */
  reason: string | null;
  /** The tool that rendered this view, when known. */
  toolName: string | null;
  theme: Theme;
}

export type ViewEvent =
  | { type: "connected"; toolName?: string | null; theme?: Theme | null }
  | { type: "connect-failed"; message: string }
  | { type: "input-partial"; arguments?: Record<string, unknown> }
  | { type: "input"; arguments?: Record<string, unknown> }
  | { type: "result"; result: ToolResultLike }
  | { type: "cancelled"; reason?: string }
  | { type: "theme"; theme: Theme }
  | { type: "tool-name"; toolName: string };

/** The parts of an MCP CallToolResult a view reads. */
export interface ToolResultLike {
  isError?: boolean;
  structuredContent?: Record<string, unknown> | null;
  content?: ReadonlyArray<{ type: string; text?: string }>;
  _meta?: Record<string, unknown>;
}

export const initialViewState: ViewState = {
  status: "connecting",
  input: null,
  result: null,
  error: null,
  reason: null,
  toolName: null,
  theme: "dark",
};

/** Read a tool result as success or failure, whatever shape the host passed it in. */
export function readToolResult(
  result: ToolResultLike,
): { ok: true; value: ToolSuccess } | { ok: false; error: ToolFailure } {
  const body = result.structuredContent ?? parseTextContent(result);
  if (body && body.ok === true) {
    const view = viewFromMeta(result._meta);
    return { ok: true, value: { ...(body as unknown as ToolSuccess), ...(view ? { view } : {}) } };
  }
  if (body && body.ok === false) {
    return {
      ok: false,
      error: {
        code: typeof body.error === "string" ? body.error : "tool_error",
        message: typeof body.message === "string" ? body.message : "The tool failed.",
        ...(typeof body.retryAfterSeconds === "number"
          ? { retryAfterSeconds: body.retryAfterSeconds }
          : {}),
      },
    };
  }
  if (result.isError) {
    const text = result.content?.find((part) => part.type === "text")?.text;
    return { ok: false, error: { code: "tool_error", message: text || "The tool failed." } };
  }
  // A result without the Ratel envelope (a host that strips structuredContent
  // and sent no text) still renders: its body is the data.
  return { ok: true, value: { ok: true, data: body ?? null } };
}

/** The view's own model, from a result's `sh.ratel/view` _meta (lib/mcp/server.ts asToolResult). */
export function viewFromMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const view = meta?.[VIEW_META_KEY];
  return view && typeof view === "object" && !Array.isArray(view)
    ? (view as Record<string, unknown>)
    : null;
}

function parseTextContent(result: ToolResultLike): Record<string, unknown> | null {
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The tool named by a result's `sh.ratel/binding` _meta (lib/mcp/apps/README.md). */
export function bindingToolFromMeta(meta: Record<string, unknown> | undefined): string | null {
  const binding = meta?.[BINDING_META_KEY];
  if (
    binding &&
    typeof binding === "object" &&
    typeof (binding as { tool?: unknown }).tool === "string"
  ) {
    return (binding as { tool: string }).tool;
  }
  return null;
}

export function viewReducer(state: ViewState, event: ViewEvent): ViewState {
  switch (event.type) {
    case "connected":
      return {
        ...state,
        status: state.status === "connecting" ? "waiting" : state.status,
        toolName: event.toolName ?? state.toolName,
        theme: event.theme ?? state.theme,
      };
    case "connect-failed":
      return {
        ...state,
        status: "error",
        error: { code: "host_unavailable", message: event.message },
      };
    case "input-partial":
      // Partial arguments only matter until the call is settled.
      if (state.status === "ready" || state.status === "error" || state.status === "cancelled")
        return state;
      return { ...state, status: "partial", input: event.arguments ?? state.input };
    case "input":
      if (state.status === "ready" || state.status === "error" || state.status === "cancelled") {
        return { ...state, input: event.arguments ?? state.input };
      }
      return { ...state, status: "waiting", input: event.arguments ?? state.input };
    case "result": {
      const read = readToolResult(event.result);
      const toolName = bindingToolFromMeta(event.result._meta) ?? state.toolName;
      return read.ok
        ? { ...state, status: "ready", result: read.value, error: null, reason: null, toolName }
        : { ...state, status: "error", result: null, error: read.error, reason: null, toolName };
    }
    case "cancelled":
      // A result that already landed stays on screen.
      if (state.status === "ready") return state;
      return { ...state, status: "cancelled", reason: event.reason ?? null };
    case "theme":
      return { ...state, theme: event.theme };
    case "tool-name":
      return { ...state, toolName: event.toolName };
  }
}

/** The project the call that rendered the view named, if it named one. */
export function inputProject(input: Record<string, unknown> | null): string | null {
  const projectId = input?.projectId;
  return typeof projectId === "string" && projectId !== "" ? projectId : null;
}

/**
 * A view's own tools/call, for the project the view is about. An API key
 * implies its project; a signed-in person (OAuth) reaches many and must name
 * it on every call (lib/mcp/dispatch.ts resolveScope), so a call without one
 * is refused. The call that rendered the view named it: every call the view
 * makes carries the same project, unless it names another.
 */
export function withProject(
  args: Record<string, unknown>,
  projectId: string | null,
): Record<string, unknown> {
  return projectId && args.projectId === undefined ? { ...args, projectId } : args;
}

/** The binding that renders this tool, or the view's only one when the tool is unknown. */
export function pickBinding<B extends McpAppBinding>(
  bindings: readonly B[],
  toolName: string | null,
): B | null {
  if (toolName) {
    const match = bindings.find((binding) => binding.tool === toolName);
    if (match) return match;
  }
  return bindings.length === 1 ? bindings[0] : null;
}
