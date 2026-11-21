import assert from "node:assert/strict";
import { test } from "node:test";
import { createKeyInventory, formatKeyInventory } from "./inventory";

const SECRET_VALUES = [
  "sk-live-123",
  "the user asked about refunds",
  "cache-hit-42",
  "prod-eu",
  "4096",
];

const TRACES = JSON.stringify({
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "prod-eu" } }] },
      scopeSpans: [
        {
          scope: { name: "deeptree.agent" },
          spans: [
            {
              traceId: "0".repeat(31) + "1",
              spanId: "0".repeat(15) + "1",
              name: "chat claude",
              startTimeUnixNano: "1751800000000000000",
              endTimeUnixNano: "1751800000200000000",
              attributes: [
                { key: "llm.prompt", value: { stringValue: "the user asked about refunds" } },
                { key: "dt.cache.key", value: { stringValue: "cache-hit-42" } },
                { key: "auth.token", value: { stringValue: "sk-live-123" } },
              ],
              events: [
                {
                  name: "cache.lookup",
                  timeUnixNano: "1751800000100000000",
                  attributes: [{ key: "cache.read_tokens", value: { intValue: "4096" } }],
                },
              ],
            },
            {
              traceId: "0".repeat(31) + "1",
              spanId: "0".repeat(15) + "2",
              name: "chat claude",
              startTimeUnixNano: "1751800000000000000",
              endTimeUnixNano: "1751800000200000000",
              attributes: [{ key: "dt.cache.key", value: { stringValue: "cache-hit-42" } }],
            },
          ],
        },
      ],
    },
  ],
});

const LOGS = JSON.stringify({
  resourceLogs: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "prod-eu" } }] },
      scopeLogs: [
        {
          scope: { name: "@ratel-ai/sdk" },
          logRecords: [
            {
              timeUnixNano: "1751800000000000000",
              eventName: "ratel.experiment.results",
              body: { stringValue: "the user asked about refunds" },
              attributes: [{ key: "ratel.experiment.id", value: { stringValue: "sk-live-123" } }],
            },
          ],
        },
      ],
    },
  ],
});

test("the inventory lists names and keys with counts, per scope", () => {
  const inventory = createKeyInventory();
  inventory.add("traces", "application/json", new TextEncoder().encode(TRACES));
  inventory.add("logs", "application/json", new TextEncoder().encode(LOGS));

  assert.deepEqual(inventory.result(), {
    exports: 2,
    spans: 2,
    logRecords: 1,
    undecodable: 0,
    scopes: [
      {
        scope: "@ratel-ai/sdk",
        spanNames: [],
        resourceKeys: [{ key: "service.name", count: 1 }],
        spanAttributeKeys: [],
        spanEventNames: [],
        spanEventAttributeKeys: [],
        logEventNames: [{ key: "ratel.experiment.results", count: 1 }],
        logAttributeKeys: [{ key: "ratel.experiment.id", count: 1 }],
      },
      {
        scope: "deeptree.agent",
        spanNames: [{ key: "chat claude", count: 2 }],
        resourceKeys: [{ key: "service.name", count: 2 }],
        spanAttributeKeys: [
          { key: "dt.cache.key", count: 2 },
          { key: "auth.token", count: 1 },
          { key: "llm.prompt", count: 1 },
        ],
        spanEventNames: [{ key: "cache.lookup", count: 1 }],
        spanEventAttributeKeys: [{ key: "cache.read_tokens", count: 1 }],
        logEventNames: [],
        logAttributeKeys: [],
      },
    ],
  });
});

test("neither the inventory nor its printout contains a value", () => {
  const inventory = createKeyInventory();
  inventory.add("traces", "application/json", new TextEncoder().encode(TRACES));
  inventory.add("logs", "application/json", new TextEncoder().encode(LOGS));
  const printed = JSON.stringify(inventory.result()) + formatKeyInventory(inventory.result());
  for (const value of SECRET_VALUES) {
    assert.ok(!printed.includes(value), `leaked ${value}`);
  }
  assert.match(printed, /dt\.cache\.key\s+2/);
});

test("a body that does not decode is counted, not thrown", () => {
  const inventory = createKeyInventory();
  inventory.add("traces", "application/x-protobuf", new Uint8Array([0xff, 0xff, 0xff]));
  assert.equal(inventory.result().undecodable, 1);
});
