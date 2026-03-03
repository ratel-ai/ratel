import { describe, it, expect, vi } from "vitest";
import { Subject } from "rxjs";
import type { BaseEvent } from "@ag-ui/client";
import { streamSSE } from "./stream-sse.js";

function mockResponse() {
  return {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  } as unknown as import("node:http").ServerResponse;
}

describe("streamSSE", () => {
  it("sets SSE headers via writeHead", () => {
    const subject = new Subject<BaseEvent>();
    const res = mockResponse();

    streamSSE(subject, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  });

  it("writes events as data: JSON\\n\\n", () => {
    const subject = new Subject<BaseEvent>();
    const res = mockResponse();

    streamSSE(subject, res);

    const event = { type: "TEXT_MESSAGE_CONTENT", delta: "hi" } as unknown as BaseEvent;
    subject.next(event);

    expect(res.write).toHaveBeenCalledWith(
      `data: ${JSON.stringify(event)}\n\n`,
    );
  });

  it("calls end() on complete", () => {
    const subject = new Subject<BaseEvent>();
    const res = mockResponse();

    streamSSE(subject, res);
    subject.complete();

    expect(res.end).toHaveBeenCalled();
  });

  it("writes RUN_ERROR + end() on error", () => {
    const subject = new Subject<BaseEvent>();
    const res = mockResponse();

    streamSSE(subject, res);
    subject.error(new Error("boom"));

    const written = (res.write as ReturnType<typeof vi.fn>).mock.calls;
    const lastWrite = written[written.length - 1]![0] as string;
    const parsed = JSON.parse(lastWrite.replace("data: ", "").trim());

    expect(parsed.type).toBe("RUN_ERROR");
    expect(parsed.message).toBe("boom");
    expect(res.end).toHaveBeenCalled();
  });

  it("unsubscribes on close event", () => {
    const subject = new Subject<BaseEvent>();
    const res = mockResponse();

    streamSSE(subject, res);

    const onCalls = (res.on as ReturnType<typeof vi.fn>).mock.calls;
    const closeCall = onCalls.find((c) => c[0] === "close");
    expect(closeCall).toBeDefined();

    closeCall![1]();

    subject.next({ type: "TEXT_MESSAGE_CONTENT" } as unknown as BaseEvent);
    expect(res.write).not.toHaveBeenCalled();
  });
});
