import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** JSON-RPC reserved code for a server-side failure. */
const INTERNAL_ERROR = -32603;

/**
 * A one-shot, in-memory MCP transport for stateless Streamable HTTP.
 *
 * The SDK ships `StreamableHTTPServerTransport`, but it is written against
 * Node's `IncomingMessage`/`ServerResponse` while App Router route handlers get
 * fetch `Request`/`Response`. Rather than shim those two interfaces (fiddly,
 * and it drags in SSE plumbing we deliberately do not serve), we implement the
 * five-method `Transport` contract directly: feed one JSON-RPC message in,
 * collect whatever the server sends back, done.
 *
 * Stateless is a deployment requirement, not a preference. The service runs
 * 1-3 Fargate tasks behind an ALB with no session affinity and rolling deploys,
 * so a session pinned to one task would break on every scale event and every
 * release. No session id is issued and none is honoured.
 */
export class SingleMessageTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly outgoing: JSONRPCMessage[] = [];
  private settle: (() => void) | null = null;
  private closed = false;

  async start(): Promise<void> {
    // Nothing to connect: messages are handed in directly by `handle`.
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.outgoing.push(message);
    // A response or error terminates the exchange for this request. Server
    // notifications (logging, progress) can precede it and are kept in order.
    if ("id" in message && ("result" in message || "error" in message)) {
      this.settle?.();
      this.settle = null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.settle?.();
    this.settle = null;
    this.onclose?.();
  }

  /**
   * Push one client message through the connected server and resolve with
   * everything it wrote back.
   *
   * Returns an empty array for notifications (which have no id and therefore no
   * response). The caller turns that into `202 Accepted` with no body, as the
   * Streamable HTTP spec requires.
   *
   * A request that never completes returns a JSON-RPC error rather than
   * nothing. Returning nothing would be indistinguishable from a notification,
   * so the caller would answer `202` and the client would sit waiting forever
   * for a reply to an id that is never coming.
   */
  async handle(message: JSONRPCMessage, timeoutMs = 30_000): Promise<JSONRPCMessage[]> {
    const isRequest = "id" in message && "method" in message;

    const completed = new Promise<void>((resolve) => {
      this.settle = resolve;
    });

    this.onmessage?.(message);

    if (!isRequest) {
      // Notifications get no reply; do not wait for one.
      this.settle = null;
      return [];
    }

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([completed, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
      this.settle = null;
    }

    // Keyed on whether the request was actually answered, not on why the wait
    // ended. A timeout is one way to arrive here unanswered; a transport closed
    // mid-flight is another, and both leave the client waiting on an id.
    if (!this.hasResponseFor(message)) {
      return [
        ...this.outgoing,
        {
          jsonrpc: "2.0",
          id: (message as { id: string | number }).id,
          error: {
            code: INTERNAL_ERROR,
            message: "The operation did not complete in time.",
          },
        } as JSONRPCMessage,
      ];
    }

    return [...this.outgoing];
  }

  /** Whether the server already answered the request we are waiting on. */
  private hasResponseFor(message: JSONRPCMessage): boolean {
    const id = (message as { id?: string | number }).id;
    return this.outgoing.some(
      (out) => "id" in out && out.id === id && ("result" in out || "error" in out),
    );
  }
}
