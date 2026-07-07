import { describe, expect, it } from "vitest";
import {
  CloudApiError,
  CloudAuthError,
  CloudConfigError,
  CloudUnavailableError,
  errorFromResponse,
} from "./errors.js";

const body = (code: string, message = "boom", details?: object) =>
  JSON.stringify({ error: { code, message, ...(details ? { details } : {}) } });

describe("errorFromResponse", () => {
  it("maps 401 to CloudAuthError", () => {
    const err = errorFromResponse(401, body("unauthorized", "bad key"));
    expect(err).toBeInstanceOf(CloudAuthError);
    expect(err.message).toContain("bad key");
  });

  it("maps 503 to CloudUnavailableError", () => {
    const err = errorFromResponse(503, body("unavailable"));
    expect(err).toBeInstanceOf(CloudUnavailableError);
  });

  it("maps 400 and 404 to CloudApiError with status and code", () => {
    const bad = errorFromResponse(400, body("invalid_request"));
    expect(bad).toBeInstanceOf(CloudApiError);
    expect((bad as CloudApiError).status).toBe(400);
    expect((bad as CloudApiError).code).toBe("invalid_request");

    const missing = errorFromResponse(404, body("not_found"));
    expect((missing as CloudApiError).status).toBe(404);
    expect((missing as CloudApiError).code).toBe("not_found");
  });

  it("maps an unexpected status to CloudApiError", () => {
    const err = errorFromResponse(418, body("invalid_request"));
    expect(err).toBeInstanceOf(CloudApiError);
    expect((err as CloudApiError).status).toBe(418);
  });

  it("falls back to the HTTP status on a malformed error body", () => {
    expect(errorFromResponse(401, "not json at all")).toBeInstanceOf(CloudAuthError);
    expect(errorFromResponse(503, '{"nope":true}')).toBeInstanceOf(CloudUnavailableError);
    const err = errorFromResponse(500, "");
    expect(err).toBeInstanceOf(CloudApiError);
    expect((err as CloudApiError).status).toBe(500);
    expect((err as CloudApiError).code).toBeUndefined();
  });

  it("ignores an error code that is not a string", () => {
    const err = errorFromResponse(400, JSON.stringify({ error: { code: 42, message: "x" } }));
    expect((err as CloudApiError).code).toBeUndefined();
  });
});

describe("error classes", () => {
  it("carry stable names for instanceof-free matching", () => {
    expect(new CloudConfigError("x").name).toBe("CloudConfigError");
    expect(new CloudAuthError("x").name).toBe("CloudAuthError");
    expect(new CloudApiError("x", 400).name).toBe("CloudApiError");
    expect(new CloudUnavailableError("x").name).toBe("CloudUnavailableError");
  });
});
