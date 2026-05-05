import { describe, it, expect, vi } from "vitest";

const { mockOpenai, mockAnthropic, mockGoogle } = vi.hoisted(() => ({
  mockOpenai: vi.fn(() => "openai-model"),
  mockAnthropic: vi.fn(() => "anthropic-model"),
  mockGoogle: vi.fn(() => "google-model"),
}));

vi.mock("@ai-sdk/openai", () => ({ openai: mockOpenai }));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: mockAnthropic }));
vi.mock("@ai-sdk/google", () => ({ google: mockGoogle }));

import { resolveModel } from "./model.js";

describe("resolveModel", () => {
  it("routes gpt-* to openai()", () => {
    resolveModel("gpt-5");
    expect(mockOpenai).toHaveBeenCalledWith("gpt-5");
  });

  it("routes claude-* to anthropic()", () => {
    resolveModel("claude-sonnet-4-5-20250929");
    expect(mockAnthropic).toHaveBeenCalledWith("claude-sonnet-4-5-20250929");
  });

  it("routes gemini-* to google()", () => {
    resolveModel("gemini-3-flash-preview");
    expect(mockGoogle).toHaveBeenCalledWith("gemini-3-flash-preview");
  });

  it("throws on unknown prefix", () => {
    expect(() => resolveModel("llama-3")).toThrow("Unknown model provider");
  });
});
