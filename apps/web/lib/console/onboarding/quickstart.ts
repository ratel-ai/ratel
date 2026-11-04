/**
 * The "send your first trace" snippets, in one place so every surface that asks
 * hands out the same wiring. Pure string builders — no React, no env reads — so
 * the snippets we ship are unit-testable (see quickstart.test.ts).
 *
 * TypeScript is the SDK path: a stock OpenTelemetry `NodeSDK` with the OTLP
 * exporter pointed at this deployment's traces endpoint and the project key as
 * a bearer header. Upstream wires its Cloud SDK's span processor here; this
 * edition's ingest accepts any OTLP exporter, so nothing beyond the OpenTelemetry
 * packages is installed. There is deliberately no Python tab: the OTel wiring is
 * the same in every language, and curl shows the request itself.
 *
 * curl is the second tab: it needs nothing installed, which is what you want
 * when the question is "is my key even working?", and it's the honest answer
 * for every runtime the SDK doesn't cover yet.
 *
 * No snippet inlines the key. Every one reads {@link QUICKSTART_KEY_ENV} from
 * the environment, so a copied snippet is never a leaked secret.
 */

export const QUICKSTART_LANGS = ["typescript", "curl"] as const;

export type QuickstartLang = (typeof QUICKSTART_LANGS)[number];

/** Tab labels — spelled the way each ecosystem spells itself. */
export const QUICKSTART_LANG_LABELS: Record<QuickstartLang, string> = {
  typescript: "TypeScript",
  curl: "curl",
};

/** The env var every snippet reads the project API key from. */
export const QUICKSTART_KEY_ENV = "RATEL_API_KEY";

export interface QuickstartTarget {
  /**
   * Absolute OTLP traces URL, e.g. `https://cloud.ratel.sh/v1/traces` (the standard OTLP path; `/api/v1/traces` is the same route).
   * Passed explicitly rather than left to the SDK default so the snippet is
   * correct on self-hosted and preview deployments too.
   */
  endpoint: string;
  /**
   * Project slug, emitted as the OTel `service.name`. This is the name traces
   * group under on the dashboard, so it has to match the project they land in.
   */
  serviceName: string;
  /**
   * Opt the snippet into content capture: search queries and tool arguments
   * ride along on the spans. Off by default, and when off the snippet is
   * byte-identical to the one we have always handed out.
   */
  captureContent?: boolean;
}

/**
 * The OTel GenAI content-capture switch. The exporter forwards whatever the
 * spans carry, so the snippet flips the ecosystem gate the Ratel SDK and other
 * GenAI instrumentations read.
 */
export const QUICKSTART_CAPTURE_ENV = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

/** Full capture: content on the span and as span events. */
export const QUICKSTART_CAPTURE_MODE = "SPAN_AND_EVENT";

/** A language's snippet plus the one-line install that precedes it. */
export interface QuickstartSnippet {
  lang: QuickstartLang;
  /** Shell command that installs what the snippet imports; null for curl. */
  install: string | null;
  /** The runnable snippet body. */
  code: string;
}

/**
 * Quote a value for embedding in a source-string literal. Double-quoted with
 * JSON escaping, which is valid in all three targets — a project slug is
 * kebab-case today, but a name that later carries a quote must not be able to
 * break out of the literal and produce a broken (or misleading) snippet.
 */
function quoted(value: string): string {
  return JSON.stringify(value);
}

/**
 * The lines that switch content capture on, set before the SDK starts. Split
 * over two lines so the snippet box never soft-wraps them.
 */
const CAPTURE_LINES: readonly string[] = [
  "// Content capture (opt-in): search queries and tool arguments ride",
  "// along on the spans. Delete these lines to send runtime events only.",
  `process.env.${QUICKSTART_CAPTURE_ENV} =`,
  `  ${quoted(QUICKSTART_CAPTURE_MODE)};`,
  "",
];

function typescriptSnippet({
  endpoint,
  serviceName,
  captureContent = false,
}: QuickstartTarget): QuickstartSnippet {
  return {
    lang: "typescript",
    install:
      "npm install @opentelemetry/api @opentelemetry/sdk-node " +
      "@opentelemetry/exporter-trace-otlp-proto",
    code: [
      'import { NodeSDK } from "@opentelemetry/sdk-node";',
      // The import is split so the package name stays inside the snippet box's
      // width; a single line soft-wraps on narrow panels.
      "import {",
      "  OTLPTraceExporter,",
      '} from "@opentelemetry/exporter-trace-otlp-proto";',
      "",
      ...(captureContent ? CAPTURE_LINES : []),
      "const sdk = new NodeSDK({",
      `  serviceName: ${quoted(serviceName)},`,
      `  // Reads ${QUICKSTART_KEY_ENV}. Sends your spans to Ratel; the gen_ai.*`,
      "  // and ratel.* ones are what the pages read.",
      // Broken across lines rather than inlined: the endpoint is long enough on
      // a real deployment that a single line soft-wraps in the snippet box,
      // leaving an unindented `}),` hanging at the left margin.
      "  traceExporter: new OTLPTraceExporter({",
      `    url: ${quoted(endpoint)},`,
      "    headers: {",
      `      Authorization: \`Bearer \${process.env.${QUICKSTART_KEY_ENV}}\`,`,
      "    },",
      "  }),",
      "});",
      "",
      "sdk.start();",
    ].join("\n"),
  };
}

/**
 * One hand-rolled OTLP span — a single `chat` call with its token counts. Kept
 * as the zero-install proof that a key reaches ingest; a `202` means accepted.
 * `captureContent` does not apply: there is no instrumentation to switch on.
 */
function curlSnippet({ endpoint }: QuickstartTarget): QuickstartSnippet {
  return {
    lang: "curl",
    install: null,
    code: [
      `curl -X POST ${endpoint} \\`,
      `  -H "Authorization: Bearer $${QUICKSTART_KEY_ENV}" \\`,
      '  -H "Content-Type: application/json" \\',
      `  -d '{ "resourceSpans": [{ "scopeSpans": [{ "spans": [{`,
      '        "traceId": "0123456789abcdef0123456789abcdef",',
      '        "spanId": "0123456789abcdef", "name": "chat", "kind": 3,',
      '        "startTimeUnixNano": "1751800000000000000",',
      '        "endTimeUnixNano": "1751800001200000000",',
      '        "attributes": [',
      '          { "key": "gen_ai.provider.name", "value": { "stringValue": "anthropic" } },',
      '          { "key": "gen_ai.request.model", "value": { "stringValue": "claude-sonnet-4-6" } },',
      '          { "key": "gen_ai.usage.input_tokens",  "value": { "intValue": "1200" } },',
      '          { "key": "gen_ai.usage.output_tokens", "value": { "intValue": "180" } }',
      "        ] }] }] }] }'",
    ].join("\n"),
  };
}

const BUILDERS: Record<QuickstartLang, (target: QuickstartTarget) => QuickstartSnippet> = {
  typescript: typescriptSnippet,
  curl: curlSnippet,
};

/** Build one language's snippet for a project's ingest endpoint. */
export function buildQuickstart(lang: QuickstartLang, target: QuickstartTarget): QuickstartSnippet {
  return BUILDERS[lang](target);
}

/** Build every language's snippet, keyed by language, for a client component. */
export function buildQuickstartSet(
  target: QuickstartTarget,
): Record<QuickstartLang, QuickstartSnippet> {
  return {
    typescript: typescriptSnippet(target),
    curl: curlSnippet(target),
  };
}
