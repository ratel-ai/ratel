import assert from "node:assert/strict";
import { test } from "node:test";
import { otlpSuccessResponse, transportFor } from "./http";

test("transportFor maps OTLP content types onto decode paths", () => {
  assert.equal(transportFor("application/json"), "json");
  assert.equal(transportFor("application/json; charset=utf-8"), "json");
  assert.equal(transportFor("application/x-protobuf"), "protobuf");
  assert.equal(transportFor("APPLICATION/X-PROTOBUF"), "protobuf");
  assert.equal(transportFor("application/octet-stream"), "protobuf");
});

test("transportFor treats a missing content type as protobuf like the SDK exporter path", () => {
  assert.equal(transportFor(""), "protobuf");
  assert.equal(transportFor("   "), "protobuf");
});

test("transportFor returns null for unsupported content types", () => {
  assert.equal(transportFor("text/plain"), null);
});

test("otlpSuccessResponse answers a protobuf export with an empty full-success body", async () => {
  const res = otlpSuccessResponse("protobuf", { accepted: 2, records: 3, dropped: 1 });

  assert.equal(res.status, 202);
  assert.equal(res.headers.get("content-type"), "application/x-protobuf");
  assert.equal((await res.arrayBuffer()).byteLength, 0);
  assert.equal(res.headers.get("x-ratel-accepted"), "2");
  assert.equal(res.headers.get("x-ratel-records"), "3");
  assert.equal(res.headers.get("x-ratel-dropped"), "1");
});

test("otlpSuccessResponse keeps the JSON envelope and adds count headers", async () => {
  const res = otlpSuccessResponse("json", { accepted: 1, calls: 1, spans: 1 });

  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { accepted: 1, calls: 1, spans: 1 });
  assert.equal(res.headers.get("x-ratel-accepted"), "1");
  assert.equal(res.headers.get("x-ratel-calls"), "1");
  assert.equal(res.headers.get("x-ratel-spans"), "1");
});
