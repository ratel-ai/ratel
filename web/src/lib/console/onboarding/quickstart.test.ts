import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildQuickstart,
  buildQuickstartSet,
  buildQuickstartVariant,
  buildQuickstartVariantSet,
  QUICKSTART_CAPTURE_ENV,
  QUICKSTART_KEY_ENV,
  QUICKSTART_LANG_LABELS,
  QUICKSTART_LANGS,
  QUICKSTART_VARIANT_LABELS,
  QUICKSTART_VARIANTS,
  type QuickstartTarget,
} from "@/lib/console/onboarding/quickstart";

const TARGET: QuickstartTarget = {
  endpoint: "https://app.ratel.sh/api/v1/traces",
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

test("TypeScript wires the cloud SDK's span processor onto a host provider", () => {
  const { code, install } = buildQuickstart("typescript", TARGET);
  assert.match(code, /import \{ RatelSpanProcessor \} from "@ratel-ai\/cloud-sdk\/otel";/);
  assert.match(
    code,
    /new RatelSpanProcessor\(\{\n {6}endpoint: "https:\/\/app\.ratel\.sh\/api\/v1\/traces",\n {4}\}\),/,
  );
  assert.match(code, /serviceName: "support-copilot",/);
  // Every line stays inside the snippet box's width, so nothing soft-wraps into
  // a hanging, unindented continuation.
  for (const line of code.split("\n")) {
    assert.ok(line.length <= 72, `line stays readable without wrapping: ${line}`);
  }
  assert.match(code, /sdk\.start\(\);/);
  // The OTel packages are optional peers of the cloud SDK: a snippet that
  // omits them from the install line fails at import, not at export time.
  assert.ok(install);
  for (const pkg of [
    "@ratel-ai/cloud-sdk",
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/exporter-trace-otlp-proto",
  ]) {
    assert.ok(install.includes(pkg), `install line covers ${pkg}`);
  }
});

test("only the languages the cloud SDK actually ships get an SDK tab", () => {
  // TypeScript is the whole SDK surface; curl is the honest fallback for every
  // other runtime. A Python tab would have to point at a different package.
  assert.deepEqual([...QUICKSTART_LANGS], ["typescript", "curl"]);
});

test("curl needs no install and posts a decodable OTLP body", () => {
  const { code, install } = buildQuickstart("curl", TARGET);
  assert.equal(install, null);
  assert.match(code, /^curl -X POST https:\/\/app\.ratel\.sh\/api\/v1\/traces/);
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
  'import { RatelSpanProcessor } from "@ratel-ai/cloud-sdk/otel";',
  "",
  "const sdk = new NodeSDK({",
  '  serviceName: "support-copilot",',
  "  spanProcessors: [",
  "    // Reads RATEL_API_KEY. Forwards gen_ai.* / ratel.* spans to",
  "    // Ratel; any exporter you already run is left untouched.",
  "    new RatelSpanProcessor({",
  '      endpoint: "https://app.ratel.sh/api/v1/traces",',
  "    }),",
  "  ],",
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
      (line) => !/content capture|along on the spans|process\.env|"SPAN_AND_EVENT"/i.test(line),
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

test("the Human tab offers NodeSDK, an existing OTel provider and curl, in that order", () => {
  assert.deepEqual([...QUICKSTART_VARIANTS], ["typescript", "provider", "curl"]);
  assert.deepEqual(
    QUICKSTART_VARIANTS.map((variant) => QUICKSTART_VARIANT_LABELS[variant]),
    ["NodeSDK", "Existing OTel provider", "curl"],
  );
  const set = buildQuickstartVariantSet(TARGET);
  assert.deepEqual(Object.keys(set), [...QUICKSTART_VARIANTS]);
  // The two shared snippets are the ones every other surface hands out.
  assert.equal(set.typescript.code, buildQuickstart("typescript", TARGET).code);
  assert.equal(set.curl.code, buildQuickstart("curl", TARGET).code);
});

test("the existing-provider snippet adds the processor instead of starting a NodeSDK", () => {
  const { code, install } = buildQuickstartVariant("provider", TARGET);
  assert.ok(!code.includes("new NodeSDK"), "no second provider");
  assert.ok(install && !install.includes("@opentelemetry/sdk-node"), "sdk-node not needed");
  assert.ok(install?.includes("@ratel-ai/cloud-sdk"));
  assert.match(
    code,
    /export const ratel = new RatelSpanProcessor\(\{\n {2}endpoint: "https:\/\/app\.ratel\.sh\/api\/v1\/traces",\n\}\);/,
  );
  assert.match(code, /@vercel\/otel/);
  assert.match(code, /spanProcessors: \["auto", ratel\]/);
  assert.match(code, /serviceName: "support-copilot"/);
  assert.match(code, /agent\/instrumentation\/ratel\.ts/);
  assert.match(code, /otelIntegration\(\{ spanProcessors: \[ratel\] \}\)/);
  assert.match(code, /Mastra/);
  assert.ok(code.includes(QUICKSTART_KEY_ENV));
  for (const line of code.split("\n")) {
    assert.ok(line.length <= 72, `line stays readable without wrapping: ${line}`);
  }
});

test("the existing-provider snippet defers capture to the framework when asked", () => {
  const off = buildQuickstartVariant("provider", TARGET).code;
  const on = buildQuickstartVariant("provider", { ...TARGET, captureContent: true }).code;
  assert.ok(!off.includes(QUICKSTART_CAPTURE_ENV));
  assert.ok(on.includes(QUICKSTART_CAPTURE_ENV));
  assert.match(on, /tracePolicy/);
  assert.ok(on.startsWith(off), "capture only appends");
  for (const line of on.split("\n")) {
    assert.ok(line.length <= 72, `line stays readable without wrapping: ${line}`);
  }
});
