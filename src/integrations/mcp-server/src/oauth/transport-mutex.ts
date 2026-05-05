import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wraps a Transport so that `send()` calls are serialized through a per-instance mutex.
 *
 * Why: `StreamableHTTPClientTransport` may run a refresh-token round-trip inside `send()`
 * when it sees a 401. Two parallel `send`s can both read the same refresh token before
 * either has saved the new one — the auth server's rotation policy then rejects the
 * second exchange and the SDK invalidates the token file. Serializing `send()` per
 * upstream means there is at most one refresh in flight; followers re-read the
 * provider's `tokens()` and proceed with a fresh `Authorization` header.
 *
 * This wrapper does not interpret 401s itself; that stays inside the SDK transport.
 */
export function wrapTransportWithSendMutex(inner: Transport): Transport {
  let chain: Promise<unknown> = Promise.resolve();

  const wrapper: Transport = {
    start: () => inner.start(),
    close: () => inner.close(),
    send: (message: JSONRPCMessage, options?: TransportSendOptions) => {
      const next = chain.then(
        () => inner.send(message, options),
        () => inner.send(message, options),
      );
      // Lock the chain on the next send's settlement (success or failure).
      chain = next.catch(() => undefined);
      return next;
    },
  };

  if (inner.setProtocolVersion) {
    wrapper.setProtocolVersion = (v) => inner.setProtocolVersion?.(v);
  }

  Object.defineProperty(wrapper, "sessionId", {
    get: () => inner.sessionId,
  });
  Object.defineProperty(wrapper, "onclose", {
    get: () => inner.onclose,
    set: (v) => {
      inner.onclose = v;
    },
  });
  Object.defineProperty(wrapper, "onerror", {
    get: () => inner.onerror,
    set: (v) => {
      inner.onerror = v;
    },
  });
  Object.defineProperty(wrapper, "onmessage", {
    get: () => inner.onmessage,
    set: (v) => {
      inner.onmessage = v;
    },
  });

  return wrapper;
}
