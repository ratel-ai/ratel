import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { resolveConfig } from "@/config";
import {
  compressForStorage,
  DEFAULT_OTLP_RAW_DAILY_BYTES,
  DEFAULT_OTLP_RAW_RETENTION_DAYS,
  otlpRawDailyByteCap,
  otlpRawRetentionDays,
} from "./domain";

test("compressForStorage gzips an uncompressed body", () => {
  const body = new TextEncoder().encode("plain protobuf bytes ".repeat(50));
  const stored = compressForStorage({ body });
  assert.deepEqual(new Uint8Array(gunzipSync(stored)), body);
  assert.ok(stored.byteLength < body.byteLength);
});

test("compressForStorage keeps a body that arrived gzipped as it came", () => {
  const body = new TextEncoder().encode("already compressed on the wire");
  const wire = new Uint8Array(gzipSync(body));
  const stored = compressForStorage({ body, gzipped: wire });
  assert.equal(stored, wire);
});

test("compressForStorage ignores a gzipped copy without the gzip magic", () => {
  const body = new TextEncoder().encode("deflate on the wire");
  const stored = compressForStorage({ body, gzipped: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(new Uint8Array(gunzipSync(stored)), body);
});

/** The settings `env` resolves to (`web/src/config.ts`). */
const config = (env: Record<string, string> = {}) => resolveConfig({ env });

test("the daily cap defaults to 1 GiB and reads OTLP_RAW_DAILY_BYTES", () => {
  assert.equal(DEFAULT_OTLP_RAW_DAILY_BYTES, 1024 ** 3);
  assert.equal(otlpRawDailyByteCap(config()), DEFAULT_OTLP_RAW_DAILY_BYTES);
  assert.equal(otlpRawDailyByteCap(config({ OTLP_RAW_DAILY_BYTES: "5000" })), 5000);
  assert.equal(otlpRawDailyByteCap(config({ OTLP_RAW_DAILY_BYTES: "0" })), 0);
  assert.throws(() => config({ OTLP_RAW_DAILY_BYTES: "-1" }), /OTLP_RAW_DAILY_BYTES/);
  assert.throws(() => config({ OTLP_RAW_DAILY_BYTES: "lots" }), /OTLP_RAW_DAILY_BYTES/);
});

test("retention defaults to 30 days and reads OTLP_RAW_RETENTION_DAYS", () => {
  assert.equal(DEFAULT_OTLP_RAW_RETENTION_DAYS, 30);
  assert.equal(otlpRawRetentionDays(undefined, config()), 30);
  assert.equal(otlpRawRetentionDays(undefined, config({ OTLP_RAW_RETENTION_DAYS: "7" })), 7);
  assert.equal(otlpRawRetentionDays(3, config({ OTLP_RAW_RETENTION_DAYS: "7" })), 3);
  assert.throws(() => config({ OTLP_RAW_RETENTION_DAYS: "0" }), /OTLP_RAW_RETENTION_DAYS/);
});
