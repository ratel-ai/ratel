import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isTelemetryExportOrigin,
  resolveSelfTelemetryConfig,
  selfTelemetryConfigWarnings,
  selfTelemetryEnabled,
  unauthenticatedOverrideWarnings,
} from "./config";

const BOTH = {
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/v1/traces",
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Bearer%20trace-token,x-signal=traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://collector.example/v1/logs",
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: "authorization=Bearer%20log-token,x-signal=logs",
};

test("self-telemetry is off unless both signal endpoints are configured", () => {
  assert.equal(selfTelemetryEnabled({}), false);
  assert.equal(
    selfTelemetryEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://c.example/v1/traces" }),
    false,
  );
  assert.equal(selfTelemetryEnabled(BOTH), true);
  assert.equal(resolveSelfTelemetryConfig({}, { deploymentEnvironment: "production" }), null);
});

test("configured endpoints export with their own headers and the environment name", () => {
  assert.deepEqual(resolveSelfTelemetryConfig(BOTH, { deploymentEnvironment: "staging" }), {
    resourceAttributes: {
      "service.name": "ratel-platform",
      "deployment.environment.name": "staging",
    },
    tracesSamplerRatio: 1,
    traces: {
      url: "https://collector.example/v1/traces",
      headers: { authorization: "Bearer trace-token", "x-signal": "traces" },
    },
    logs: {
      url: "https://collector.example/v1/logs",
      headers: { authorization: "Bearer log-token", "x-signal": "logs" },
    },
  });
});

test("an endpoint without headers exports unauthenticated and is flagged for a boot warning", () => {
  const environment = {
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/v1/traces",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://collector.example/v1/logs",
  };
  const config = resolveSelfTelemetryConfig(environment, {});
  assert.deepEqual(config?.traces.headers, {});
  const warnings = unauthenticatedOverrideWarnings(environment);
  assert.equal(warnings.length, 2);
  assert.ok(warnings[0].includes("OTEL_EXPORTER_OTLP_TRACES_HEADERS"));
  assert.deepEqual(unauthenticatedOverrideWarnings(BOTH), []);
});

test("OTEL_TRACES_SAMPLER_ARG configures and clamps the root trace sample ratio", () => {
  for (const [value, expected] of [
    ["0.25", 0.25],
    ["2", 1],
    ["-0.5", 0],
    ["garbage", 1],
  ] as const) {
    const config = resolveSelfTelemetryConfig({ ...BOTH, OTEL_TRACES_SAMPLER_ARG: value }, {});
    assert.equal(config?.tracesSamplerRatio, expected, value);
  }
});

test("OTEL_SDK_DISABLED is an emergency stop and silences the warnings", () => {
  const environment = { ...BOTH, OTEL_SDK_DISABLED: " TRUE " };
  assert.equal(resolveSelfTelemetryConfig(environment, {}), null);
  assert.deepEqual(selfTelemetryConfigWarnings(environment, {}, null), []);
});

test("a partial configuration names the missing signal and the disabled setup", () => {
  const environment = { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/v1/traces" };
  const config = resolveSelfTelemetryConfig(environment, {});
  const warnings = selfTelemetryConfigWarnings(environment, {}, config);
  assert.equal(config, null);
  assert.ok(warnings.some((w) => w.includes("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")));
  assert.ok(warnings.some((w) => w.includes("telemetry will remain disabled")));
  assert.deepEqual(
    selfTelemetryConfigWarnings({}, {}, null),
    [],
    "nothing configured, nothing to warn about",
  );
});

test("exporter origins are recognised so their own traffic is not re-traced", () => {
  const config = resolveSelfTelemetryConfig(BOTH, {});
  assert.ok(config);
  assert.equal(isTelemetryExportOrigin("https://collector.example", config), true);
  assert.equal(isTelemetryExportOrigin("https://api.example", config), false);
  assert.equal(isTelemetryExportOrigin("not a url", config), false);
});
