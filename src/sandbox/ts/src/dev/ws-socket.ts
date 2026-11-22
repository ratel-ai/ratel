import WebSocket from "ws";

// The websocket adapter of `ratel sandbox dev`: one outbound socket, text frames only.

export interface SocketHandlers {
  onOpen(): void;
  onText(text: string): void;
  onClose(reason: string): void;
}

export interface Socket {
  send(text: string): void;
  close(): void;
}

/** Opens one socket. Every failure, before or after open, ends in exactly one onClose. */
export function openSocket(url: string, handlers: SocketHandlers): Socket {
  const ws = new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 65536 });
  let closed = false;
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    handlers.onClose(reason);
  };
  ws.on("open", () => handlers.onOpen());
  ws.on("message", (data, isBinary) => {
    if (!isBinary) handlers.onText(data.toString());
  });
  ws.on("error", (err) => {
    close(err.message);
    ws.terminate();
  });
  ws.on("close", (code, reason) => close(reason.length > 0 ? `${code} ${reason}` : String(code)));
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close: () => {
      closed = true;
      ws.close(1000, "worker closing");
    },
  };
}
