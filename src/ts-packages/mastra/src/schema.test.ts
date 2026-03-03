import { describe, it, expect } from "vitest";
import { z } from "zod";
import { jsonSchemaToZod } from "./schema.js";

describe("jsonSchemaToZod", () => {
  it("converts string fields", () => {
    const schema = jsonSchemaToZod({
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(schema.parse({ name: "Alice" })).toEqual({ name: "Alice" });
    expect(() => schema.parse({ name: 42 })).toThrow();
  });

  it("converts number fields", () => {
    const schema = jsonSchemaToZod({
      properties: { age: { type: "number" } },
      required: ["age"],
    });
    expect(schema.parse({ age: 30 })).toEqual({ age: 30 });
  });

  it("converts integer fields as number", () => {
    const schema = jsonSchemaToZod({
      properties: { count: { type: "integer" } },
      required: ["count"],
    });
    expect(schema.parse({ count: 5 })).toEqual({ count: 5 });
  });

  it("converts boolean fields", () => {
    const schema = jsonSchemaToZod({
      properties: { active: { type: "boolean" } },
      required: ["active"],
    });
    expect(schema.parse({ active: true })).toEqual({ active: true });
  });

  it("converts enum to z.enum", () => {
    const schema = jsonSchemaToZod({
      properties: { status: { type: "string", enum: ["active", "inactive"] } },
      required: ["status"],
    });
    expect(schema.parse({ status: "active" })).toEqual({ status: "active" });
    expect(() => schema.parse({ status: "unknown" })).toThrow();
  });

  it("converts nested objects", () => {
    const schema = jsonSchemaToZod({
      properties: {
        address: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
      required: ["address"],
    });
    expect(schema.parse({ address: { city: "NYC" } })).toEqual({
      address: { city: "NYC" },
    });
  });

  it("converts objects without properties to z.record", () => {
    const schema = jsonSchemaToZod({
      properties: { meta: { type: "object" } },
      required: ["meta"],
    });
    expect(schema.parse({ meta: { foo: "bar" } })).toEqual({
      meta: { foo: "bar" },
    });
  });

  it("converts arrays with item schema", () => {
    const schema = jsonSchemaToZod({
      properties: { tags: { type: "array", items: { type: "string" } } },
      required: ["tags"],
    });
    expect(schema.parse({ tags: ["a", "b"] })).toEqual({ tags: ["a", "b"] });
  });

  it("handles required vs optional fields", () => {
    const schema = jsonSchemaToZod({
      properties: {
        name: { type: "string" },
        nick: { type: "string" },
      },
      required: ["name"],
    });
    expect(schema.parse({ name: "Alice" })).toEqual({ name: "Alice" });
    expect(() => schema.parse({})).toThrow();
  });

  it("preserves field descriptions", () => {
    const schema = jsonSchemaToZod({
      properties: { name: { type: "string", description: "Full name" } },
      required: ["name"],
    });
    const nameField = schema.shape.name;
    expect(nameField.description).toBe("Full name");
  });

  it("handles empty schema", () => {
    const schema = jsonSchemaToZod({});
    expect(schema.parse({})).toEqual({});
  });
});
