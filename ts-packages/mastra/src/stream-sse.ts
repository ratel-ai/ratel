import type { ServerResponse } from "node:http";
import type { Observable } from "rxjs";
import type { BaseEvent } from "@ag-ui/client";

export function streamSSE(
  observable: Observable<BaseEvent>,
  res: ServerResponse,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sub = observable.subscribe({
    next: (e) => res.write(`data: ${JSON.stringify(e)}\n\n`),
    complete: () => res.end(),
    error: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      res.write(
        `data: ${JSON.stringify({ type: "RUN_ERROR", message: msg })}\n\n`,
      );
      res.end();
    },
  });

  res.on("close", () => sub.unsubscribe());
}
