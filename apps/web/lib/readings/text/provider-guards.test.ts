import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicJudge } from "@/lib/views/eval-gate/models";

// A lone surrogate makes a provider reject the whole request. The fetch clients
// have direct tests next to them. These cover the Anthropic SDK clients, which
// most code builds inside a function: a call that does not go through the guard
// fails here.

// Owned: this file sits in lib/readings/text, two levels under lib/ (upstream's is one).
const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Owned: the formatter here may break the argument onto its own line, so whitespace is skipped.
const SDK_CALL = /\.messages\.(create|stream)\(\s*([^)]{0,20})/g;

function libSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) return libSources(full);
    return /\.tsx?$/.test(item.name) && !/\.test\.tsx?$/.test(item.name) ? [full] : [];
  });
}

test("every Anthropic SDK call in lib sends its params through wellFormedJson", () => {
  const calls: string[] = [];
  const unguarded: string[] = [];
  for (const file of libSources(LIB)) {
    for (const match of readFileSync(file, "utf8").matchAll(SDK_CALL)) {
      const where = `${path.relative(LIB, file)}: ${match[0]}`;
      calls.push(where);
      if (!match[2].startsWith("wellFormedJson(")) unguarded.push(where);
    }
  }
  assert.ok(calls.length >= 9, `found only ${calls.length} calls: the scan no longer sees them`);
  assert.deepEqual(unguarded, []);
});

test("the Anthropic judge sends no lone surrogate", async () => {
  let sent: unknown;
  const client = {
    messages: {
      create: async (params: unknown) => {
        sent = params;
        return {
          content: [{ type: "text", text: '{"pass":true,"reason":"ok"}' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  } as unknown as Anthropic;
  await anthropicJudge(client, "claude-sonnet-4-5").judge({
    criteria: "find \uD83D",
    run: "ran \uDE00",
  });
  assert.doesNotMatch(JSON.stringify(sent), /\\ud[89ab-f]/i);
});
