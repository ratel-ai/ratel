import type { Observable } from "rxjs";
import type { BaseEvent } from "@ag-ui/client";
import type { FastifyReply } from "fastify";

export function serveAgUi(
  observable: Observable<BaseEvent>,
  reply: FastifyReply,
): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sub = observable.subscribe({
    next: (e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`),
    complete: () => reply.raw.end(),
    error: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      reply.raw.write(
        `data: ${JSON.stringify({ type: "RUN_ERROR", message: msg })}\n\n`,
      );
      reply.raw.end();
    },
  });

  reply.raw.on("close", () => sub.unsubscribe());
}
