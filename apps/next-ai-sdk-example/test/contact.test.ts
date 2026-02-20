import { describe, it, expect } from "vitest";
import { POST } from "../src/app/api/contact/route";

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/contact", () => {
  it("returns 200 for valid data", async () => {
    const res = await POST(jsonRequest({ name: "Ada", email: "ada@test.com", message: "Hello" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.message).toContain("Ada");
  });

  it("returns 400 when fields are missing", async () => {
    const res = await POST(jsonRequest({ name: "Ada" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("All fields are required");
  });

  it("returns 400 for invalid email", async () => {
    const res = await POST(jsonRequest({ name: "Ada", email: "bad", message: "Hi" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid email format");
  });
});
