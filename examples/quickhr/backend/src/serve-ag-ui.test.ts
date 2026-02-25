import { describe, it, expect, vi } from "vitest";
import { Subject } from "rxjs";
import type { BaseEvent } from "@ag-ui/client";
import { serveAgUi } from "./serve-ag-ui.js";

function mockReply() {
  const raw = {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
  return { raw } as unknown as import("fastify").FastifyReply;
}

describe("serveAgUi", () => {
  it("sets SSE headers", () => {
    const subject = new Subject<BaseEvent>();
    const reply = mockReply();

    serveAgUi(subject, reply);

    expect(reply.raw.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  });

  it("writes each event as SSE data line", () => {
    const subject = new Subject<BaseEvent>();
    const reply = mockReply();

    serveAgUi(subject, reply);

    const event = { type: "TEXT_MESSAGE_CONTENT", delta: "hi" } as unknown as BaseEvent;
    subject.next(event);

    expect(reply.raw.write).toHaveBeenCalledWith(
      `data: ${JSON.stringify(event)}\n\n`,
    );
  });

  it("ends response on observable complete", () => {
    const subject = new Subject<BaseEvent>();
    const reply = mockReply();

    serveAgUi(subject, reply);
    subject.complete();

    expect(reply.raw.end).toHaveBeenCalled();
  });

  it("writes RUN_ERROR and ends on observable error", () => {
    const subject = new Subject<BaseEvent>();
    const reply = mockReply();

    serveAgUi(subject, reply);
    subject.error(new Error("something broke"));

    const written = (reply.raw.write as ReturnType<typeof vi.fn>).mock.calls;
    const lastWrite = written[written.length - 1]![0] as string;
    const parsed = JSON.parse(lastWrite.replace("data: ", "").trim());

    expect(parsed.type).toBe("RUN_ERROR");
    expect(parsed.message).toBe("something broke");
    expect(reply.raw.end).toHaveBeenCalled();
  });

  it("unsubscribes from observable on connection close", () => {
    const subject = new Subject<BaseEvent>();
    const reply = mockReply();

    serveAgUi(subject, reply);

    // Simulate close: find the "close" handler registered via reply.raw.on
    const onCalls = (reply.raw.on as ReturnType<typeof vi.fn>).mock.calls;
    const closeCall = onCalls.find((c) => c[0] === "close");
    expect(closeCall).toBeDefined();

    // Trigger close
    closeCall![1]();

    // Observable should be unsubscribed — further events should not write
    subject.next({ type: "TEXT_MESSAGE_CONTENT" } as unknown as BaseEvent);
    // writeHead was called once at setup, write should not have been called for the event
    expect(reply.raw.write).not.toHaveBeenCalled();
  });
});
