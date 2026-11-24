import type { ScorerDraft, ScorerTrace } from "./types";

export function traceFixture(overrides: Partial<ScorerTrace> = {}): ScorerTrace {
  return {
    traceId: "a".repeat(32),
    startedAt: new Date("2026-11-20T10:00:00Z"),
    durationMs: 100,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    error: false,
    models: [],
    tools: [],
    agents: [],
    mcpServers: [],
    service: null,
    environment: null,
    attributes: {},
    ...overrides,
  };
}

type CheckDraft = Extract<ScorerDraft, { kind: "check" }>;
type JudgeDraft = Extract<ScorerDraft, { kind: "judge" }>;

export function checkDraft(overrides: Partial<CheckDraft> = {}): CheckDraft {
  return {
    name: "Fast enough",
    kind: "check",
    config: { path: "duration_ms", op: "lte", value: 1000 },
    filter: {},
    sampleRate: 100,
    enabled: true,
    ...overrides,
  };
}

export function judgeDraft(overrides: Partial<JudgeDraft> = {}): JudgeDraft {
  return {
    name: "Polite",
    kind: "judge",
    config: { prompt: "Is the answer polite?", output: "boolean" },
    filter: {},
    sampleRate: 100,
    enabled: true,
    ...overrides,
  };
}
