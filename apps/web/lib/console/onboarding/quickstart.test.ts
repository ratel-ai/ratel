import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildQuickstart,
  buildQuickstartSet,
  QUICKSTART_CAPTURE_ENV,
  QUICKSTART_KEY_ENV,
  QUICKSTART_LANG_LABELS,
  QUICKSTART_LANGS,
  type QuickstartTarget,
} from "@/lib/console/onboarding/quickstart";

const TARGET: QuickstartTarget = {
  endpoint: "https://cloud.ratel.sh/api/v1/traces",
  serviceName: "support-copilot",
};

test("every language is labelled and buildable", () => {
  for (const lang of QUICKSTART_LANGS) {
    const snippet = buildQuickstart(lang, TARGET);
    assert.equal(snippet.lang, lang);
    assert.ok(QUICKSTART_LANG_LABELS[lang], `${lang} has a tab label`);
    assert.ok(snippet.code.length > 0, `${lang} has a body`);
  }
});

test("no snippet inlines a key — each reads it from the environment", () => {
  for (const lang of QUICKSTART_LANGS) {
    const { code, install } = buildQuickstart(lang, TARGET);
    assert.ok(code.includes(QUICKSTART_KEY_ENV), `${lang} names ${QUICKSTART_KEY_ENV}`);
    assert.ok(!/rtl_/.test(code), `${lang} carries no key-shaped literal`);
    assert.ok(!/Bearer\s+(?!\$)/.test(code), `${lang} passes no literal bearer token`);
    if (install) assert.ok(!install.includes("rtl_"), `${lang} install line is key-free`);
  }
});

test("every snippet targets the endpoint it was built for", () => {
  const self = { endpoint: "http://localhost:3000/api/v1/traces", serviceName: "local" };
  for (const lang of QUICKSTART_LANGS) {
    assert.ok(
      buildQuickstart(lang, self).code.includes(self.endpoint),
      `${lang} points at the passed endpoint, not a hardcoded host`,
    );
  }
});

test("TypeScript wires a stock OTLP exporter with the key as a bearer header", () => {
  const { code, install } = buildQuickstart("typescript", TARGET);
  assert.match(
    code,
    /import \{\n {2}OTLPTraceExporter,\n\} from "@opentelemetry\/exporter-trace-otlp-proto";/,
  );
  assert.match(
    code,
    /traceExporter: new OTLPTraceExporter\(\{\n {4}url: "https:\/\/cloud\.ratel\.sh\/api\/v1\/traces",\n {4}headers: \{\n {6}Authorization: `Bearer \$\{process\.env\.RATEL_API_KEY\}`,\n {4}\},\n {2}\}\),/,
  );
  assert.match(code, /serviceName: "support-copilot",/);
  // Every line stays inside the snippet box's width, so nothing soft-wraps into
  // a hanging, unindented continuation.
  for (const line of code.split("\n")) {
    assert.ok(line.length <= 72, `line stays readable without wrapping: ${line}`);
  }
  assert.match(code, /sdk\.start\(\);/);
  // Nothing beyond the OpenTelemetry packages: ingest accepts any OTLP exporter.
  assert.ok(install);
  for (const pkg of [
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@opentelemetry/exporter-trace-otlp-proto",
  ]) {
    assert.ok(install.includes(pkg), `install line covers ${pkg}`);
  }
  assert.ok(!install.includes("cloud-sdk"), "the install line names no Cloud package");
});

test("TypeScript and curl are the tabs", () => {
  // The OTel wiring is the same in every language, and curl shows the request
  // itself, so a Python tab would add nothing the reader cannot see here.
  assert.deepEqual([...QUICKSTART_LANGS], ["typescript", "curl"]);
});

test("curl needs no install and posts a decodable OTLP body", () => {
  const { code, install } = buildQuickstart("curl", TARGET);
  assert.equal(install, null);
  assert.match(code, /^curl -X POST https:\/\/cloud\.ratel\.sh\/api\/v1\/traces/);
  assert.match(code, /Authorization: Bearer \$RATEL_API_KEY/);

  // The -d payload has to survive JSON.parse and carry the gen_ai attributes
  // the pipeline aggregates on — a snippet that 400s is worse than no snippet.
  const body = code.slice(code.indexOf("'") + 1, code.lastIndexOf("'"));
  const parsed = JSON.parse(body) as {
    resourceSpans: { scopeSpans: { spans: { attributes: { key: string }[] }[] }[] }[];
  };
  const span = parsed.resourceSpans[0].scopeSpans[0].spans[0];
  const keys = span.attributes.map((a) => a.key);
  assert.deepEqual(keys, [
    "gen_ai.provider.name",
    "gen_ai.request.model",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
  ]);
});

test("a service name that carries a quote cannot break out of the literal", () => {
  const hostile = { ...TARGET, serviceName: 'evil" + leak + "' };
  assert.match(
    buildQuickstart("typescript", hostile).code,
    /serviceName: "evil\\" \+ leak \+ \\"",/,
  );
});

test("buildQuickstartSet returns one entry per language", () => {
  const set = buildQuickstartSet(TARGET);
  assert.deepEqual(Object.keys(set).sort(), [...QUICKSTART_LANGS].sort());
  for (const lang of QUICKSTART_LANGS) {
    assert.deepEqual(set[lang], buildQuickstart(lang, TARGET));
  }
});

// The snippet every existing surface hands out, pinned so the capture option
// can never change it by accident.
const TYPESCRIPT_WITHOUT_CAPTURE = [
  'import { NodeSDK } from "@opentelemetry/sdk-node";',
  "import {",
  "  OTLPTraceExporter,",
  '} from "@opentelemetry/exporter-trace-otlp-proto";',
  "",
  "const sdk = new NodeSDK({",
  '  serviceName: "support-copilot",',
  "  // Reads RATEL_API_KEY. Sends your spans to Ratel; the gen_ai.*",
  "  // and ratel.* ones are what the pages read.",
  "  traceExporter: new OTLPTraceExporter({",
  '    url: "https://cloud.ratel.sh/api/v1/traces",',
  "    headers: {",
  `      Authorization: \`Bearer \${process.env.RATEL_API_KEY}\`,`,
  "    },",
  "  }),",
  "});",
  "",
  "sdk.start();",
].join("\n");

test("content capture is off by default and leaves every snippet unchanged", () => {
  assert.equal(buildQuickstart("typescript", TARGET).code, TYPESCRIPT_WITHOUT_CAPTURE);
  for (const lang of QUICKSTART_LANGS) {
    const implicit = buildQuickstart(lang, TARGET);
    const explicit = buildQuickstart(lang, { ...TARGET, captureContent: false });
    assert.deepEqual(explicit, implicit, `${lang} is identical when capture is off`);
    assert.ok(!implicit.code.includes(QUICKSTART_CAPTURE_ENV), `${lang} omits the capture switch`);
  }
});

test("content capture is emitted only when asked, before the SDK starts", () => {
  const { code, install } = buildQuickstart("typescript", { ...TARGET, captureContent: true });
  assert.match(
    code,
    /process\.env\.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =\n {2}"SPAN_AND_EVENT";/,
  );
  assert.equal(code.split(QUICKSTART_CAPTURE_ENV).length, 2, "the switch appears once");
  assert.ok(
    code.indexOf(QUICKSTART_CAPTURE_ENV) < code.indexOf("const sdk"),
    "the gate is set before the provider is built",
  );
  // Everything else is the snippet a customer already knows.
  const withoutCapture = code
    .split("\n")
    .filter(
      (line) =>
        !/content capture|along on the spans|process\.env\.OTEL|"SPAN_AND_EVENT"/i.test(line),
    )
    .join("\n")
    .replace("\n\n\n", "\n\n");
  assert.equal(withoutCapture, TYPESCRIPT_WITHOUT_CAPTURE);
  for (const line of code.split("\n")) {
    assert.ok(line.length <= 72, `line stays readable without wrapping: ${line}`);
  }
  assert.equal(
    install,
    buildQuickstart("typescript", TARGET).install,
    "no extra package to install",
  );
});

test("curl has no instrumentation to switch, so capture leaves it alone", () => {
  assert.deepEqual(
    buildQuickstart("curl", { ...TARGET, captureContent: true }),
    buildQuickstart("curl", TARGET),
  );
});

test("buildQuickstartSet passes the capture choice through", () => {
  const set = buildQuickstartSet({ ...TARGET, captureContent: true });
  assert.ok(set.typescript.code.includes(QUICKSTART_CAPTURE_ENV));
});
