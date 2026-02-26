import type { LanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";

export function resolveModel(modelId: string): LanguageModel {
  if (modelId.startsWith("gpt-")) return openai(modelId);
  if (modelId.startsWith("claude-")) return anthropic(modelId);
  if (modelId.startsWith("gemini-")) return google(modelId);
  throw new Error(`Unknown model provider for: ${modelId}`);
}

export function toMastraModel(modelId: string): string {
  if (modelId.startsWith("gpt-")) return `openai/${modelId}`;
  if (modelId.startsWith("claude-")) return `anthropic/${modelId}`;
  if (modelId.startsWith("gemini-")) return `google/${modelId}`;
  throw new Error(`Unknown model provider for: ${modelId}`);
}
