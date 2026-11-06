import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeJson } from "./decode";
import { groupSpans } from "./group";
import { toRow } from "./reconstruct";

/**
 * Full ingest pipeline (decode → group → reconstruct → categorize) over an
 * OTLP/JSON export whose structured content rides as JSON strings — the shape the
 * seed script and many real instrumentations emit (exercises the `attrStructured`
 * JSON-parse branch end to end, which the unit tests using native arrays don't).
 */

const START_NS = "1751800000000000000";
const END_NS = "1751800004000000000";

const sv = (s: string) => ({ stringValue: s });
const iv = (n: number) => ({ intValue: String(n) });
const kv = (key: string, value: unknown) => ({ key, value });
const jv = (obj: unknown) => ({ stringValue: JSON.stringify(obj) });

function seedLikeBody(): Uint8Array {
  const system = `You are a coding assistant.\n<skill name="git">${"g".repeat(2000)}</skill>\n<memory>${"m".repeat(600)}</memory>`;
  const toolDefs = [
    { name: "search_code", description: "s".repeat(400), parameters: { type: "object" } },
    { name: "read_file", description: "r".repeat(400), parameters: { type: "object" } },
    { name: "legacy_a", description: "x".repeat(2000), parameters: { type: "object" } }, // unused
    { name: "legacy_b", description: "y".repeat(2000), parameters: { type: "object" } }, // unused
  ];
  const inputMessages = [
    { role: "user", parts: [{ type: "text", content: "h".repeat(800) }] },
    { role: "assistant", parts: [{ type: "text", content: "a".repeat(800) }] },
    { role: "user", parts: [{ type: "text", content: "the current question" }] },
  ];
  const outputMessages = [
    {
      role: "assistant",
      parts: [
        { type: "text", content: "On it." },
        { type: "tool_call", id: "c1", name: "search_code", arguments: { q: "x" } },
      ],
    },
  ];

  const request = {
    resourceSpans: [
      {
        resource: { attributes: [kv("service.name", sv("agent"))] },
        scopeSpans: [
          {
            scope: { name: "ratel" },
            spans: [
              {
                traceId: "0".repeat(31) + "1",
                spanId: "0".repeat(15) + "1",
                name: "chat claude-opus-4-8",
                kind: 3,
                startTimeUnixNano: START_NS,
                endTimeUnixNano: END_NS,
                attributes: [
                  kv("gen_ai.operation.name", sv("chat")),
                  kv("gen_ai.provider.name", sv("anthropic")),
                  kv("gen_ai.request.model", sv("claude-opus-4-8")),
                  kv("gen_ai.response.id", sv("resp-1")),
                  kv("gen_ai.usage.input_tokens", iv(12000)),
                  kv("gen_ai.usage.output_tokens", iv(600)),
                  // Cache covers the stable prefix (skills+memory+tools) and spills
                  // into older history — as the seed's cache model produces.
                  kv("gen_ai.usage.cache_read.input_tokens", iv(11500)),
                  kv("gen_ai.tool.definitions", jv(toolDefs)),
                ],
                events: [
                  {
                    name: "gen_ai.client.inference.operation.details",
                    timeUnixNano: START_NS,
                    attributes: [
                      kv("gen_ai.system_instructions", jv([{ type: "text", content: system }])),
                      kv("gen_ai.input.messages", jv(inputMessages)),
                      kv("gen_ai.output.messages", jv(outputMessages)),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  return Buffer.from(JSON.stringify(request), "utf8");
}

test("seed-shaped JSON-string content → full 5-way split lands in the metric row", () => {
  const rows = groupSpans(decodeJson(seedLikeBody())).map((c) => toRow("proj-1", c));
  assert.equal(rows.length, 1);
  const { event, metric } = rows[0];

  // Header/usage/cost.
  assert.equal(event.provider, "anthropic");
  assert.equal(event.model, "claude-opus-4-8");
  assert.equal(event.inputTokens, 12000);
  assert.equal(event.cachedTokens, 11500);
  assert.equal(event.latencyMs, 4000);
  assert.ok(event.costUsd != null);

  // The context split reconciles to input_tokens and every source is populated.
  const t = metric.tokensByCategory;
  const sum = t.skills + t.tools + t.history + t.memory + t.user_input;
  assert.equal(sum, 12000);
  assert.ok(t.skills > 0, "skill block detected in the system prompt");
  assert.ok(t.tools > 0, "offered tool catalog attributed");
  assert.ok(t.history > 0, "prior turns attributed to history");
  assert.ok(t.memory > 0, "memory block detected");

  // Used vs unused: search_code called, two legacy tools never called.
  assert.equal(metric.toolsTotalCount, 4);
  assert.ok(metric.splits.tools_unused > 0, "legacy tools shipped but never called");
  assert.ok(metric.splits.tools_used > 0, "search_code was called");
  assert.ok(metric.splits.history_cached > 0, "cache_read spilled into history");
});
