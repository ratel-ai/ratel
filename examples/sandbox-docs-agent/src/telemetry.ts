import {
  type Attributes,
  type Context,
  context,
  createContextKey,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { GEN_AI_OPERATION_NAME } from "@ratel-ai/telemetry";

// Traces to Ratel: the host owns the tracer provider and adds an OTLP exporter
// with the project key. Without RATEL_API_KEY, nothing is exported.

export const DEFAULT_ENDPOINT = "https://cloud.ratel.sh/v1/traces";
export const GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id";
export const GEN_AI_AGENT_NAME = "gen_ai.agent.name";
const INVOKE_AGENT = "invoke_agent";
const CONVERSATION = createContextKey("docs-agent.conversation-id");

/** Copies the turn's conversation ID onto every span started inside it (AI SDK chat and tool spans). */
export class ConversationIdProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const id = parentContext.getValue(CONVERSATION);
    if (typeof id === "string") span.setAttribute(GEN_AI_CONVERSATION_ID, id);
  }
  onEnd(): void {}
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface Telemetry {
  readonly exporting: boolean;
  shutdown(): Promise<void>;
}

export function setupTelemetry(env: NodeJS.ProcessEnv = process.env): Telemetry {
  const apiKey = env.RATEL_API_KEY;
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "sandbox-docs-agent" }),
    spanProcessors: [
      new ConversationIdProcessor(),
      ...(apiKey
        ? [
            new BatchSpanProcessor(
            new OTLPTraceExporter({
              url: env.RATEL_OTLP_ENDPOINT ?? DEFAULT_ENDPOINT,
                headers: { Authorization: `Bearer ${apiKey}` },
              }),
            ),
          ]
        : []),
    ],
  });
  provider.register();
  return { exporting: Boolean(apiKey), shutdown: () => provider.shutdown() };
}

/**
 * One turn of a session under its `invoke_agent docs-agent` root span, with
 * the session as `gen_ai.conversation.id`. A sandbox run gets this root from the
 * runner instead.
 */
export function inAgentTurn<T>(sessionId: string, body: () => Promise<T>): Promise<T> {
  const attributes: Attributes = {
    [GEN_AI_OPERATION_NAME]: INVOKE_AGENT,
    [GEN_AI_AGENT_NAME]: "docs-agent",
    [GEN_AI_CONVERSATION_ID]: sessionId,
  };
  return trace
    .getTracer("sandbox-docs-agent")
    .startActiveSpan(`${INVOKE_AGENT} docs-agent`, { attributes }, async (span) => {
      try {
        return await context.with(context.active().setValue(CONVERSATION, sessionId), body);
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
      }
    });
}
