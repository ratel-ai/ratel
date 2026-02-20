import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { contactRoutes } from "../src/routes/contact.js";

describe("POST /api/contact", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await contactRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with valid data", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contact",
      payload: { name: "Alice", email: "alice@test.com", message: "Hello" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it("returns 400 when fields missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contact",
      payload: { name: "Alice" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for invalid email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/contact",
      payload: { name: "Alice", email: "not-email", message: "Hello" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("email");
  });
});
