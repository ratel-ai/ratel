import assert from "node:assert/strict";
import { test } from "node:test";
import { MCP_SESSION_KEYS } from "@/lib/ingest/otlp/attr-resolve";
import {
  CLIENT_ADDRESS_KEYS,
  CLIENT_NAME_KEY,
  CLIENT_VERSION_KEY,
  PROTOCOL_VERSION_KEY,
  USER_AGENT_KEYS,
} from "@/lib/ingest/otlp/dimensions/client";
import { MCP_METHOD_KEY, SERVER_INFO_KEYS } from "@/lib/ingest/otlp/dimensions/mcp";
import { buildMcpServerGuide } from "./setup-guide";

const guide = buildMcpServerGuide({
  tracesEndpoint: "https://cloud.ratel.sh/v1/traces",
  serviceName: "notes-mcp",
});
const listed = guide.facts.flatMap((row) => row.attributes);

test("the fact table names every key ingest reads for an MCP server and its clients", () => {
  for (const key of [
    MCP_METHOD_KEY,
    PROTOCOL_VERSION_KEY,
    CLIENT_NAME_KEY,
    CLIENT_VERSION_KEY,
    ...SERVER_INFO_KEYS,
    ...USER_AGENT_KEYS,
    ...CLIENT_ADDRESS_KEYS,
    ...MCP_SESSION_KEYS,
  ]) {
    assert.ok(listed.includes(key), `${key} is in the fact table`);
  }
});

test("only the explicit client name is SDK only", () => {
  assert.deepEqual(
    guide.facts.filter((row) => row.source === "sdk").map((row) => row.attributes),
    [[CLIENT_NAME_KEY, CLIENT_VERSION_KEY]],
  );
});

test("each snippet sets service.name to the server's name and reads the exporter from env", () => {
  assert.deepEqual(
    guide.snippets.map((s) => s.lang),
    ["python", "typescript"],
  );
  assert.match(guide.snippets[0]!.files[0]!.code, /"service.name": "notes-mcp"/);
  assert.match(guide.snippets[1]!.files[0]!.code, /serviceName: "notes-mcp"/);
  assert.match(
    guide.env,
    /^export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https:\/\/cloud\.ratel\.sh\/v1\/traces$/m,
  );
  assert.match(guide.env, /Authorization=Bearer%20\$\{RATEL_API_KEY\}/);
});

test("the guide states the stdio and stateless limits and how to send no client IP", () => {
  assert.ok(guide.limits.some((line) => line.startsWith("stdio has no IP and no User-Agent")));
  assert.ok(guide.limits.some((line) => line.startsWith("Stateless HTTP has no session")));
  for (const key of CLIENT_ADDRESS_KEYS)
    assert.match(guide.noClientIp.collector, new RegExp(`key: ${key.replace(/\./g, "\\.")}`));
  assert.match(guide.noClientIp.python, /"client": None/);
});

test("no em dashes in the guide", () => {
  assert.doesNotMatch(JSON.stringify(guide), /—/);
});
