import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "./logger";
import { setRequestLogContext, withRequestLog } from "./request-log";

test("preserves the CloudWatch request fields as top-level pino fields", async () => {
  const { logger, records } = createCaptureLogger();
  const original = new Response("created", {
    status: 201,
    statusText: "Created",
    headers: { "x-custom": "preserved" },
  });
  const handler = withRequestLog(async (request) => {
    setRequestLogContext(request, {
      project_id: "project-1",
      org_id: "org-1",
    });
    return original;
  }, logger);
  const response = await handler(
    new Request("https://cloud.ratel.sh/api/things?draft=true", {
      method: "POST",
      headers: { "x-request-id": "incoming-id" },
    }),
  );

  assert.equal(response, original);
  assert.equal(response.status, 201);
  assert.equal(response.statusText, "Created");
  assert.equal(response.headers.get("x-custom"), "preserved");
  assert.equal(response.headers.get("x-request-id"), "incoming-id");
  assert.equal(await response.text(), "created");
  assert.equal(records.length, 1);
  assert.deepEqual(
    {
      requestId: records[0].requestId,
      method: records[0].method,
      path: records[0].path,
      status: records[0].status,
      durationType: typeof records[0].duration_ms,
      project_id: records[0].project_id,
      org_id: records[0].org_id,
      distinctId: records[0].distinctId,
      module: records[0].module,
      msg: records[0].msg,
    },
    {
      requestId: "incoming-id",
      method: "POST",
      path: "/api/things",
      status: 201,
      durationType: "number",
      project_id: "project-1",
      org_id: "org-1",
      distinctId: "project:project-1",
      module: "request-log",
      msg: "api_request",
    },
  );
});

test("logs status 500 and rethrows the original handler error", async () => {
  const { logger, records } = createCaptureLogger();
  const thrown = new Error("database unavailable");
  const handler = withRequestLog(async () => {
    throw thrown;
  }, logger);
  const request = new Request("https://cloud.ratel.sh/api/things/123", {
    method: "DELETE",
    headers: { "x-request-id": "error-id" },
  });

  try {
    await handler(request);
    assert.fail("expected handler to throw");
  } catch (error) {
    assert.equal(error, thrown);
  }

  assert.equal(records.length, 1);
  assert.equal(records[0].level, 50);
  assert.equal(records[0].msg, "api_request");
  assert.equal(records[0].requestId, "error-id");
  assert.equal(records[0].method, "DELETE");
  assert.equal(records[0].path, "/api/things/123");
  assert.equal(records[0].status, 500);
  assert.equal(typeof records[0].duration_ms, "number");
});

test("generates a request id and maps the request identity into the log context", async () => {
  const { logger, records } = createCaptureLogger();
  const handler = withRequestLog(async (request) => {
    setRequestLogContext(request, {
      project_id: "project-1",
      org_id: "org-1",
      distinct_id: "user_123",
    });
    return new Response(null, { status: 204 });
  }, logger);
  const response = await handler(new Request("https://cloud.ratel.sh/api/things"));

  const requestId = response.headers.get("x-request-id");
  assert.match(
    requestId ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].requestId, requestId);
  assert.equal(records[0].project_id, "project-1");
  assert.equal(records[0].org_id, "org-1");
  assert.equal(records[0].distinctId, "user_123");
});

test("request context enriches the active span at the same seam", () => {
  const request = new Request("https://cloud.ratel.sh/api/things");
  const annotations: Array<Record<string, unknown>> = [];
  const context = {
    project_id: "project-1",
    org_id: "org-1",
    distinct_id: "user_123",
  };

  setRequestLogContext(request, context, (annotation) => {
    annotations.push(annotation);
  });

  assert.deepEqual(annotations, [
    {
      project_id: "project-1",
      org_id: "org-1",
      distinctId: "user_123",
    },
  ]);
});

test("preserves an immutable response while adding the request id", async () => {
  const { logger, records } = createCaptureLogger();
  const handler = withRequestLog(
    async () => Response.redirect("https://cloud.ratel.sh/login", 302),
    logger,
  );
  const response = await handler(
    new Request("https://cloud.ratel.sh/api/private", {
      headers: { "x-request-id": "redirect-id" },
    }),
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://cloud.ratel.sh/login");
  assert.equal(response.headers.get("x-request-id"), "redirect-id");
  assert.equal(await response.text(), "");
  assert.equal(records.length, 1);
});

function createCaptureLogger() {
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  }).child({ module: "request-log" });

  return { logger, records };
}
