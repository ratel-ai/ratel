import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { createLogger, getLogger, runWithLogContext, setLogContext } from "./logger";

test("production logs default to info", () => {
  const logger = createLogger({ environment: { NODE_ENV: "production" } });

  assert.equal(logger.level, "info");
});

test("development logs default to debug", () => {
  const logger = createLogger({ environment: { NODE_ENV: "development" } });

  assert.equal(logger.level, "debug");
});

test("LOG_LEVEL overrides the environment default", () => {
  const logger = createLogger({
    environment: { NODE_ENV: "production", LOG_LEVEL: "warn" },
  });

  assert.equal(logger.level, "warn");
});

test("module loggers carry their module as a child binding", () => {
  const logger = getLogger("request-log");

  assert.deepEqual(logger.bindings(), { module: "request-log" });
});

test("errors are serialized with their type, message, and stack", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    environment: { NODE_ENV: "production" },
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  const error = new TypeError("database unavailable");

  logger.error({ err: error }, "query_failed");

  assert.equal(records.length, 1);
  assert.deepEqual(
    {
      type: (records[0].err as Record<string, unknown>).type,
      message: (records[0].err as Record<string, unknown>).message,
      stack: typeof (records[0].err as Record<string, unknown>).stack,
    },
    {
      type: "TypeError",
      message: "database unavailable",
      stack: "string",
    },
  );
});

test("null error values do not break logging", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });

  assert.doesNotThrow(() => logger.error({ err: null }, "operation_failed"));
  assert.equal(records[0].err, null);
});

/** A vendor-style error that folds the request it failed on into its own fields. */
class WebhookSignatureError extends Error {
  readonly type = "WebhookSignatureError";
  constructor(
    readonly header: string,
    readonly payload: string,
  ) {
    super(`No signatures found matching the expected signature for payload ${payload}`);
    this.name = "WebhookSignatureError";
  }
}

test("vendor errors carrying request material lose it and their derived message", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  const error = new WebhookSignatureError(
    "t=123,v1=signature-secret",
    '{"email":"customer@example.com"}',
  );

  logger.error({ err: error }, "webhook_signature_verification_failed");

  const loggedError = records[0].err as Record<string, unknown>;
  assert.deepEqual(
    {
      type: loggedError.type,
      message: loggedError.message,
      stack: typeof loggedError.stack,
      payload: loggedError.payload,
      header: loggedError.header,
    },
    {
      type: "WebhookSignatureError",
      message: "[redacted]",
      stack: "string",
      payload: undefined,
      header: undefined,
    },
  );
  assert.equal(JSON.stringify(loggedError).includes("customer@example.com"), false);
});

test("undefined third-party fields do not hide an actionable message", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  const error = Object.assign(new Error("network failed"), {
    type: "ConnectionError",
    code: undefined,
    requestId: undefined,
  });

  logger.error({ err: error }, "vendor_connection_failed");

  const loggedError = records[0].err as Record<string, unknown>;
  assert.equal(loggedError.message, "network failed");
});

test("Anthropic response bodies cannot leak through the derived message or stack", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  const error = Anthropic.APIError.generate(
    400,
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "bad input customer@example.com",
      },
    },
    undefined,
    new Headers({ "request-id": "request-1" }),
  );

  logger.error({ err: error }, "anthropic_request_failed");

  const loggedError = records[0].err as Record<string, unknown>;
  assert.equal(JSON.stringify(loggedError).includes("customer@example.com"), false);
  assert.equal(loggedError.type, "BadRequestError");
  assert.equal(loggedError.message, "[redacted]");
  assert.equal(loggedError.status, 400);
  assert.equal(loggedError.requestID, "request-1");
});

test("unsafe cause details cannot leak through the parent message or stack", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  const cause = Anthropic.APIError.generate(
    400,
    {
      type: "error",
      error: { message: "bad input customer@example.com" },
    },
    undefined,
    new Headers(),
  );
  const error = new Error("request failed", { cause });

  logger.error({ err: error }, "anthropic_request_failed");

  const loggedError = records[0].err as Record<string, unknown>;
  assert.equal(JSON.stringify(loggedError).includes("customer@example.com"), false);
  assert.equal(loggedError.message, "[redacted]");
});

test("error serialization keeps safe diagnostics and omits database internals", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  const error = Object.assign(new Error("query failed"), {
    code: "23505",
    status: 409,
    statusCode: 409,
    requestId: "request-lower-d",
    requestID: "request-upper-d",
    doc_url: "https://docs.example.com/error-codes/card-declined",
    param: "payment_method",
    decline_code: "insufficient_funds",
    severity: "ERROR",
    constraint: "users_email_key",
    table: "users",
    column: "email",
    dataType: "text",
    schema: "public",
    routine: "_bt_check_unique",
    clerkTraceId: "clerk-trace-1",
    detail: "Key (email)=(customer@example.com) already exists",
    internalQuery: "select * from users where email = 'customer@example.com'",
  });

  logger.error({ err: error }, "query_failed");

  const loggedError = records[0].err as Record<string, unknown>;
  assert.deepEqual(
    {
      code: loggedError.code,
      status: loggedError.status,
      statusCode: loggedError.statusCode,
      requestId: loggedError.requestId,
      requestID: loggedError.requestID,
      doc_url: loggedError.doc_url,
      param: loggedError.param,
      decline_code: loggedError.decline_code,
      severity: loggedError.severity,
      constraint: loggedError.constraint,
      table: loggedError.table,
      column: loggedError.column,
      dataType: loggedError.dataType,
      schema: loggedError.schema,
      routine: loggedError.routine,
      clerkTraceId: loggedError.clerkTraceId,
      detail: loggedError.detail,
      internalQuery: loggedError.internalQuery,
    },
    {
      code: "23505",
      status: 409,
      statusCode: 409,
      requestId: "request-lower-d",
      requestID: "request-upper-d",
      doc_url: "https://docs.example.com/error-codes/card-declined",
      param: "payment_method",
      decline_code: "insufficient_funds",
      severity: "ERROR",
      constraint: "users_email_key",
      table: "users",
      column: "email",
      dataType: "text",
      schema: "public",
      routine: "_bt_check_unique",
      clerkTraceId: "clerk-trace-1",
      detail: undefined,
      internalQuery: undefined,
    },
  );
});

test("error diagnostics drop structured values", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  const error = Object.assign(new Error("query failed"), {
    code: { customer_email: "customer@example.com" },
    constraint: "users_email_key",
  });

  logger.error({ err: error }, "query_failed");

  const loggedError = records[0].err as Record<string, unknown>;
  assert.equal(loggedError.code, undefined);
  assert.equal(loggedError.constraint, "users_email_key");
  assert.equal(loggedError.message, "[redacted]");
});

test("aggregate error entries use the safe diagnostic allowlist", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  const nestedError = Object.assign(new Error("nested query failed"), {
    code: "23505",
    detail: "Key (email)=(customer@example.com) already exists",
  });
  const error = new AggregateError([nestedError], "batch failed");

  logger.error({ err: error }, "batch_failed");

  const loggedError = records[0].err as Record<string, unknown>;
  const aggregateErrors = loggedError.aggregateErrors as Array<Record<string, unknown>> | undefined;
  assert.deepEqual(
    {
      count: aggregateErrors?.length,
      type: aggregateErrors?.[0]?.type,
      message: aggregateErrors?.[0]?.message,
      stack: typeof aggregateErrors?.[0]?.stack,
      code: aggregateErrors?.[0]?.code,
      detail: aggregateErrors?.[0]?.detail,
    },
    {
      count: 1,
      type: "Error",
      message: "[redacted]",
      stack: "string",
      code: "23505",
      detail: undefined,
    },
  );
});

test("aggregate error serialization tolerates null entries", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  const error = new AggregateError([null], "batch failed");

  assert.doesNotThrow(() => logger.error({ err: error }, "batch_failed"));
  const loggedError = records[0].err as Record<string, unknown>;
  assert.deepEqual(loggedError.aggregateErrors, [null]);
});

test("credentials are redacted from structured records", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });

  logger.info({
    authorization: "Bearer secret",
    apiKey: "rk_secret",
    cookie: "session=secret",
  });

  assert.deepEqual(
    {
      authorization: records[0].authorization,
      apiKey: records[0].apiKey,
      cookie: records[0].cookie,
    },
    {
      authorization: "[Redacted]",
      apiKey: "[Redacted]",
      cookie: "[Redacted]",
    },
  );
});

test("credentials are redacted from common nested request fields", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });

  logger.info({
    headers: { authorization: "Bearer secret", cookie: "session=secret" },
    config: { apiKey: "rk_secret" },
  });

  assert.deepEqual(records[0].headers, {
    authorization: "[Redacted]",
    cookie: "[Redacted]",
  });
  assert.deepEqual(records[0].config, { apiKey: "[Redacted]" });
});

test("request context is mixed into records and derives the project distinct id", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });

  runWithLogContext({ requestId: "request-1", project_id: "project-1", org_id: "org-1" }, () =>
    logger.info("inside_request"),
  );
  logger.info("outside_request");

  assert.deepEqual(
    {
      requestId: records[0].requestId,
      project_id: records[0].project_id,
      org_id: records[0].org_id,
      distinctId: records[0].distinctId,
    },
    {
      requestId: "request-1",
      project_id: "project-1",
      org_id: "org-1",
      distinctId: "project:project-1",
    },
  );
  assert.equal(records[1].requestId, undefined);
});

test("resolved request context merges into the active log context", () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });

  runWithLogContext({ requestId: "request-1" }, () => {
    setLogContext({
      project_id: "project-1",
      org_id: "org-1",
      distinctId: "user_123",
    });
    logger.info("request_resolved");
  });

  assert.deepEqual(
    {
      requestId: records[0].requestId,
      project_id: records[0].project_id,
      org_id: records[0].org_id,
      distinctId: records[0].distinctId,
    },
    {
      requestId: "request-1",
      project_id: "project-1",
      org_id: "org-1",
      distinctId: "user_123",
    },
  );
});
