import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTED, redactAttributes, redactKeyValues, redactText } from "./redact";

const READ = { readContent: true };

test("credential headers, keys and the command line are redacted", () => {
  assert.deepEqual(
    redactAttributes(
      {
        "http.request.header.authorization": ["Bearer sk-live-1"],
        "http.request.header.x-api-key": "sk-live-2",
        "http.response.header.set-cookie": "session=abc",
        "openai.api_key": "sk-live-3",
        "db.password": "hunter2",
        "process.command_line": "node agent.js --token sk-live-4",
        "gen_ai.usage.input_tokens": 120,
        "ratel.token_count": 7,
        "service.name": "agent",
      },
      READ,
    ),
    {
      "http.request.header.authorization": REDACTED,
      "http.request.header.x-api-key": REDACTED,
      "http.response.header.set-cookie": REDACTED,
      "openai.api_key": REDACTED,
      "db.password": REDACTED,
      "process.command_line": REDACTED,
      "gen_ai.usage.input_tokens": 120,
      "ratel.token_count": 7,
      "service.name": "agent",
    },
  );
});

test("credential query params and URL passwords are redacted, other params kept", () => {
  assert.deepEqual(
    redactAttributes(
      {
        "url.full": "https://api.example.com/v1/search?q=rome&api_key=sk-live-1&page=2",
        "http.url": "https://user:hunter2@api.example.com/v1?token=abc#frag",
        "url.query": "key=AIza-1&q=rome",
        "server.address": "api.example.com",
      },
      READ,
    ),
    {
      "url.full": `https://api.example.com/v1/search?q=rome&api_key=${REDACTED}&page=2`,
      "http.url": `https://user:${REDACTED}@api.example.com/v1?token=${REDACTED}#frag`,
      "url.query": `key=${REDACTED}&q=rome`,
      "server.address": "api.example.com",
    },
  );
});

test("read_content off drops content keys and keeps the rest", () => {
  assert.deepEqual(
    redactAttributes(
      {
        "gen_ai.input.messages": "[]",
        "gen_ai.prompt.0.content": "hi",
        "gen_ai.tool.call.arguments": '{"q":"rome"}',
        "gen_ai.request.model": "gpt-4o",
      },
      { readContent: false },
    ),
    { "gen_ai.request.model": "gpt-4o" },
  );
});

test("OTLP key-values are redacted the same way, nested lists too", () => {
  assert.deepEqual(
    redactKeyValues(
      [
        {
          key: "http.request.header.authorization",
          value: { arrayValue: { values: [{ stringValue: "Bearer x" }] } },
        },
        { key: "url.full", value: { stringValue: "https://x.test/?api_key=1" } },
        {
          key: "headers",
          value: { kvlistValue: { values: [{ key: "cookie", value: { stringValue: "s=1" } }] } },
        },
        { key: "count", value: { doubleValue: 1.5 } },
      ],
      READ,
    ),
    [
      { key: "http.request.header.authorization", value: { stringValue: REDACTED } },
      { key: "url.full", value: { stringValue: `https://x.test/?api_key=${REDACTED}` } },
      {
        key: "headers",
        value: { kvlistValue: { values: [{ key: "cookie", value: { stringValue: REDACTED } }] } },
      },
      { key: "count", value: { doubleValue: 1.5 } },
    ],
  );
  assert.deepEqual(
    redactKeyValues(
      [
        { key: "gen_ai.input.messages", value: { stringValue: "[]" } },
        { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
      ],
      { readContent: false },
    ),
    [{ key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } }],
  );
});

test("read_content off keeps only keys that carry no content, whatever vocabulary sent them", () => {
  assert.deepEqual(
    redactAttributes(
      {
        "ai.prompt.messages": "[]",
        "input.value": "hi",
        "llm.input_messages.0.message.content": "hi",
        "traceloop.entity.input": "{}",
        "gen_ai.request.model": "gpt-4o",
        "ratel.run.id": "r1",
        "service.name": "agent",
        "http.request.method": "GET",
        "error.type": "Timeout",
      },
      { readContent: false },
    ),
    {
      "gen_ai.request.model": "gpt-4o",
      "ratel.run.id": "r1",
      "service.name": "agent",
      "http.request.method": "GET",
      "error.type": "Timeout",
    },
  );
});

test("credential shapes: paths with a query, empty users, passwords with @, token-named keys", () => {
  assert.deepEqual(
    redactAttributes(
      {
        "http.target": "/v1/models?api_key=X1&q=rome",
        "url.path": "/cb?access_token=X2",
        "db.connection_string": "redis://:X3@cache:6379/0",
        "peer.url": "postgres://user:p@X4@db/x",
        "aws.secret_access_key": "X5",
        "aws.session_token": "X6",
        "http.request.header.x-goog-api-key": "X7",
        "gen_ai.usage.input_tokens": 9,
        "ratel.token_count": 7,
      },
      READ,
    ),
    {
      "http.target": `/v1/models?api_key=${REDACTED}&q=rome`,
      "url.path": `/cb?access_token=${REDACTED}`,
      "db.connection_string": `redis://:${REDACTED}@cache:6379/0`,
      "peer.url": `postgres://user:${REDACTED}@db/x`,
      "aws.secret_access_key": REDACTED,
      "aws.session_token": REDACTED,
      "http.request.header.x-goog-api-key": REDACTED,
      "gen_ai.usage.input_tokens": 9,
      "ratel.token_count": 7,
    },
  );
});

test("plain text with a question mark is left as sent", () => {
  assert.deepEqual(redactAttributes({ "gen_ai.prompt": "what is key=value? token=abc" }, READ), {
    "gen_ai.prompt": "what is key=value? token=abc",
  });
});

test("free text redacts a URL credential", () => {
  assert.equal(redactText("GET /v1?api_key=X1"), `GET /v1?api_key=${REDACTED}`);
  assert.equal(
    redactText("failed: https://x.test/y?token=X2"),
    `failed: https://x.test/y?token=${REDACTED}`,
  );
});
