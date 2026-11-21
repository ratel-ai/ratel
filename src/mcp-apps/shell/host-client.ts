/**
 * The View side of MCP Apps (SEP-1865), as a small JSON-RPC client over
 * postMessage.
 *
 * Why not ext-apps' `App`: it validates every message with zod through the MCP
 * SDK's schemas, which puts ~330 KB of zod into each view, nearly the whole
 * size budget (490 KB, mcp-apps/build.test.ts). The wire protocol is small
 * and the same in ext-apps 1.x and 2.x, so this speaks it directly and takes
 * only ext-apps' types (erased at build). host-client.test.ts runs it against
 * ext-apps' own host, `AppBridge`, so the two cannot drift apart silently.
 */
import type {
  McpUiAppCapabilities,
  McpUiHostContext,
  McpUiInitializeResult,
  McpUiMessageRequest,
  McpUiToolCancelledNotification,
  McpUiToolInputNotification,
  McpUiToolInputPartialNotification,
  McpUiToolResultNotification,
  McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps";

/** The MCP Apps protocol version this client speaks (ext-apps LATEST_PROTOCOL_VERSION). */
export const PROTOCOL_VERSION = "2026-01-26";

const METHOD_NOT_FOUND = -32601;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Where messages go and come from: the host window, or an in-memory pair in tests. */
export interface Channel {
  post(message: unknown): void;
  listen(handler: (data: unknown) => void): () => void;
}

/** The parent window, accepting messages only from it. */
export function windowChannel(target: Window = window.parent): Channel {
  return {
    post: (message) => target.postMessage(message, "*"),
    listen: (handler) => {
      const listener = (event: MessageEvent) => {
        if (event.source === target) handler(event.data);
      };
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
  };
}

export class HostRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "HostRequestError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type JsonRpc = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface CallToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export class HostClient {
  ontoolinput?: (params: McpUiToolInputNotification["params"]) => void;
  ontoolinputpartial?: (params: McpUiToolInputPartialNotification["params"]) => void;
  ontoolresult?: (params: McpUiToolResultNotification["params"]) => void;
  ontoolcancelled?: (params: McpUiToolCancelledNotification["params"]) => void;
  onhostcontextchanged?: (context: McpUiHostContext) => void;
  onteardown?: () => void | Promise<void>;

  private nextId = 1;
  private readonly pending = new Map<string | number, Pending>();
  private unlisten: (() => void) | null = null;
  private hostContext: McpUiHostContext | undefined;
  private initialized: McpUiInitializeResult | undefined;

  constructor(
    private readonly channel: Channel,
    private readonly appInfo: { name: string; version: string },
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    /** What the view tells the host it supports; display modes a host only offers when declared. */
    private readonly appCapabilities: McpUiAppCapabilities = {},
  ) {}

  /** ui/initialize, then ui/notifications/initialized. */
  async connect(): Promise<McpUiInitializeResult> {
    if (this.unlisten) throw new Error("Already connected");
    this.unlisten = this.channel.listen((data) => this.receive(data));
    const result = (await this.request("ui/initialize", {
      appInfo: this.appInfo,
      appCapabilities: this.appCapabilities,
      protocolVersion: PROTOCOL_VERSION,
    })) as McpUiInitializeResult;
    this.initialized = result;
    this.hostContext = result.hostContext;
    this.notify("ui/notifications/initialized", {});
    return result;
  }

  close(): void {
    this.unlisten?.();
    this.unlisten = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Connection closed"));
      this.pending.delete(id);
    }
  }

  getHostContext(): McpUiHostContext | undefined {
    return this.hostContext;
  }

  getHostCapabilities(): McpUiInitializeResult["hostCapabilities"] | undefined {
    return this.initialized?.hostCapabilities;
  }

  callServerTool(params: CallToolParams): Promise<CallToolResult> {
    return this.request(
      "tools/call",
      params as unknown as Record<string, unknown>,
    ) as Promise<CallToolResult>;
  }

  openLink(params: { url: string }): Promise<unknown> {
    return this.request("ui/open-link", params);
  }

  sendMessage(params: McpUiMessageRequest["params"]): Promise<unknown> {
    return this.request("ui/message", params as unknown as Record<string, unknown>);
  }

  updateModelContext(params: McpUiUpdateModelContextRequest["params"]): Promise<unknown> {
    return this.request("ui/update-model-context", params as unknown as Record<string, unknown>);
  }

  /** Ask to go inline, fullscreen or picture-in-picture; the host answers with the mode it set. */
  async requestDisplayMode(params: {
    mode: "inline" | "fullscreen" | "pip";
  }): Promise<{ mode: string }> {
    const result = (await this.request("ui/request-display-mode", params)) as
      | { mode?: string }
      | undefined;
    const mode = result?.mode ?? params.mode;
    this.hostContext = { ...this.hostContext, displayMode: mode as never };
    return { mode };
  }

  sendSizeChanged(params: { width?: number; height?: number }): void {
    this.notify("ui/notifications/size-changed", params);
  }

  /** Report the document's size whenever it changes, as ext-apps' autoResize does. */
  autoResize(): () => void {
    let scheduled = false;
    let lastWidth = 0;
    let lastHeight = 0;
    const measure = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const root = document.documentElement;
        const previous = root.style.height;
        root.style.height = "max-content";
        const height = Math.ceil(root.getBoundingClientRect().height);
        root.style.height = previous;
        const width = Math.ceil(window.innerWidth);
        if (width !== lastWidth || height !== lastHeight) {
          lastWidth = width;
          lastHeight = height;
          this.sendSizeChanged({ width, height });
        }
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    observer.observe(document.body);
    // The app's own root grows with its content even when html and body do not.
    const root = document.getElementById("root");
    if (root) observer.observe(root);
    return () => observer.disconnect();
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostRequestError(-32001, `${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.channel.post({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.channel.post({ jsonrpc: "2.0", method, params });
  }

  private receive(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const message = data as JsonRpc;
    if (message.jsonrpc !== "2.0") return;

    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new HostRequestError(message.error.code, message.error.message));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.answer(message.id, message.method);
      return;
    }

    const params = (message.params ?? {}) as never;
    switch (message.method) {
      case "ui/notifications/tool-input":
        this.ontoolinput?.(params);
        break;
      case "ui/notifications/tool-input-partial":
        this.ontoolinputpartial?.(params);
        break;
      case "ui/notifications/tool-result":
        this.ontoolresult?.(params);
        break;
      case "ui/notifications/tool-cancelled":
        this.ontoolcancelled?.(params);
        break;
      case "ui/notifications/host-context-changed":
        this.hostContext = { ...this.hostContext, ...(params as McpUiHostContext) };
        this.onhostcontextchanged?.(params);
        break;
    }
  }

  /** Requests from the host: ping and teardown; anything else is not offered. */
  private async answer(id: string | number, method: string): Promise<void> {
    if (method === "ping") {
      this.channel.post({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "ui/resource-teardown") {
      await this.onteardown?.();
      this.channel.post({ jsonrpc: "2.0", id, result: {} });
    } else {
      this.channel.post({
        jsonrpc: "2.0",
        id,
        error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` },
      });
    }
  }
}
