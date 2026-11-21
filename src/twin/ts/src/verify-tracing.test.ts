import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import labelTwin, { EXAMPLE } from "./test-support/verify-project/agents/label.twin.js";
import { verifyTwin } from "./verify.js";
import { CAPTURE_CONTENT_ENV, installVerifyTracing } from "./verify-tracing.js";

describe("installVerifyTracing", () => {
  it("keeps the sentinels in memory: a provider the project registers later exports nothing", async () => {
    const env: NodeJS.ProcessEnv = {};
    const tracing = installVerifyTracing(env);
    expect(env[CAPTURE_CONTENT_ENV]).toBe("SPAN_AND_EVENT");
    // The project's own provider, with an exporter, registered after the runner's.
    const projectExporter = new InMemorySpanExporter();
    const project = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(projectExporter)],
    });
    expect(trace.setGlobalTracerProvider(project)).toBe(false);

    process.env[CAPTURE_CONTENT_ENV] = "SPAN_AND_EVENT";
    const report = await verifyTwin(labelTwin, {
      input: EXAMPLE,
      spans: tracing,
      env: { ANTHROPIC_API_KEY: "set" },
      sentinel: () => "ratel-verify-secret-sentinel",
    });
    delete process.env[CAPTURE_CONTENT_ENV];

    expect(report.ok).toBe(true);
    expect(projectExporter.getFinishedSpans()).toHaveLength(0);
  });
});
