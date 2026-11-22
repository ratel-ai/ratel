import { type TracerProvider, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { defaultResource, type Resource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { LiveSpans } from "./live-spans.js";

// Playground trace export (spec §10) in the `ratel sandbox dev` child. The runner adds
// one OTLP exporter to the tracer provider the project already has. It
// registers a provider only when the project has none, so there is never a
// second one. Only the traces of playground runs leave, with the playground
// resource attributes merged in.

export const TRACES_PATH = "/api/v1/traces";
export const PLAYGROUND_ENVIRONMENT = "playground";

type ExportDone = Parameters<SpanExporter["export"]>[1];

export type ResourceAttributes = Readonly<Record<string, string | boolean>>;

export interface PlaygroundTelemetryConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly resource: ResourceAttributes;
}

export interface PlaygroundExport {
  /** Sends the span.ref events of a watched run while its spans start and end. */
  readonly live: LiveSpans;
  /** "registered": the project had no provider. "attached": added to the project's provider. */
  readonly mode: "registered" | "attached" | "unsupported";
  /** Marks a trace as a playground run, so its spans are exported. */
  track(traceId: string): void;
  flush(): Promise<void>;
}

/** The resource attributes of spec §10 for one runner. */
export function playgroundResource(input: {
  readonly build?: { readonly id?: string; readonly dirty?: boolean };
  readonly runner: { readonly instanceId: string; readonly host?: string };
  readonly sdk: { readonly name: string; readonly version: string };
}): ResourceAttributes {
  return {
    "deployment.environment.name": PLAYGROUND_ENVIRONMENT,
    ...(input.build?.id ? { "ratel.build.id": input.build.id } : {}),
    ...(input.build?.dirty !== undefined ? { "ratel.build.dirty": input.build.dirty } : {}),
    "ratel.runner.instance_id": input.runner.instanceId,
    ...(input.runner.host ? { "ratel.runner.host": input.runner.host } : {}),
    "ratel.runner.sdk.name": input.sdk.name,
    "ratel.runner.sdk.version": input.sdk.version,
  };
}

/**
 * Adds the playground exporter to the global tracer provider. Call it after the
 * project's code has loaded, so a provider the project registers is found.
 */
export function attachPlaygroundExport(
  config: PlaygroundTelemetryConfig,
  exporter: SpanExporter = new OTLPTraceExporter({
    url: new URL(TRACES_PATH, config.baseUrl).href,
    headers: { authorization: `Bearer ${config.apiKey}` },
  }),
): PlaygroundExport {
  const tracked = new Set<string>();
  const filtered = new PlaygroundExporter(
    exporter,
    resourceFromAttributes(config.resource),
    tracked,
  );
  const processor = new BatchSpanProcessor(filtered, { scheduledDelayMillis: 500 });
  const live = new LiveSpans();
  const mode = addProcessor(bothProcessors(processor, live.processor), config.resource);
  return {
    live,
    mode,
    track: (traceId) => {
      tracked.add(traceId);
      // Bounded: a long session keeps the most recent runs.
      if (tracked.size > 10_000) tracked.delete(tracked.values().next().value as string);
    },
    flush: () => processor.forceFlush(),
  };
}

/** Wraps the OTLP exporter: keeps playground traces only and merges the playground resource. */
class PlaygroundExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly resource: Resource,
    private readonly tracked: ReadonlySet<string>,
  ) {}

  export(spans: ReadableSpan[], done: ExportDone): void {
    const mine = spans.filter((span) => this.tracked.has(span.spanContext().traceId));
    if (mine.length === 0) {
      done({ code: 0 });
      return;
    }
    this.inner.export(
      mine.map((span) => withResource(span, span.resource.merge(this.resource))),
      done,
    );
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/** One processor for the export and the live trace, so the provider gets one addition. */
function bothProcessors(exporting: SpanProcessor, live: SpanProcessor): SpanProcessor {
  return {
    onStart: (span, parent) => {
      live.onStart(span, parent);
      exporting.onStart(span, parent);
    },
    onEnd: (span) => {
      live.onEnd(span);
      exporting.onEnd(span);
    },
    forceFlush: () => exporting.forceFlush(),
    shutdown: () => exporting.shutdown(),
  };
}

/** The project's provider gets the processor. With none, the runner registers the only one. */
function addProcessor(
  processor: SpanProcessor,
  resource: ResourceAttributes,
): PlaygroundExport["mode"] {
  const provider = sdkProvider(trace.getTracerProvider());
  if (!provider) {
    new NodeTracerProvider({
      resource: defaultResource().merge(resourceFromAttributes(resource)),
      spanProcessors: [processor],
    }).register();
    return "registered";
  }
  if (typeof provider.addSpanProcessor === "function") {
    // OpenTelemetry JS SDK 1.x.
    provider.addSpanProcessor(processor);
    return "attached";
  }
  // SDK 2.x takes processors in its constructor only. Its tracers share one
  // MultiSpanProcessor, so adding to its list reaches spans of existing tracers too.
  const list = provider._activeSpanProcessor?._spanProcessors;
  if (Array.isArray(list)) {
    list.push(processor);
    return "attached";
  }
  return "unsupported";
}

interface SdkProviderShape {
  forceFlush(): Promise<void>;
  addSpanProcessor?: (processor: SpanProcessor) => void;
  _activeSpanProcessor?: { _spanProcessors?: unknown };
}

/** The SDK provider behind the global proxy, or undefined when only the no-op one is there. */
function sdkProvider(global: TracerProvider): SdkProviderShape | undefined {
  const delegate = (global as { getDelegate?: () => TracerProvider }).getDelegate?.() ?? global;
  return typeof (delegate as Partial<SdkProviderShape>).forceFlush === "function"
    ? (delegate as unknown as SdkProviderShape)
    : undefined;
}

function withResource(span: ReadableSpan, resource: Resource): ReadableSpan {
  return Object.create(span, { resource: { value: resource, enumerable: true } });
}
