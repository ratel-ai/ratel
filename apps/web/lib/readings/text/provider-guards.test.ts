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
  // The eval gate makes all its calls through one `tracked` (lib/eval-gate/models.ts), so it counts once.
  // Owned: the JSON features call Claude through the model kit's adapter (ADR-0033), which
  // holds their two calls (`create`, and `stream` for a long answer), so the floor is lower than
  // upstream's 8. The analyst is on the kit too; the floor drops again as the eval gate moves.
  assert.ok(calls.length >= 5, `found only ${calls.length} calls: the scan no longer sees them`);
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

// Owned (ADR-0033): a feature asks the model kit for a model and never talks to a vendor. A
// vendor SDK may be imported by the Claude client, its error mapping, and the kit's adapters.
const VENDOR_SDK =
  /from "(@anthropic-ai\/[^"]*|openai|@ai-sdk\/[^"]*|@google\/(?:genai|generative-ai)|@aws-sdk\/client-bedrock[^"]*|@mistralai\/[^"]*|cohere-ai|ollama)"/;

const VENDOR_SDK_ALLOWED = new Set([
  "platform/anthropic-errors.ts",
  "readings/anthropic/client.ts",
  "readings/models/providers/anthropic.ts",
  "readings/models/providers/claude-hosts.ts",
  "readings/models/providers/cloud-auth.ts",
  // Not on the kit yet. Remove each as it moves.
  "views/eval-gate/models.ts",
]);

test("only the Claude client and the model kit's adapters import a vendor SDK", () => {
  const importers = libSources(LIB)
    .filter((file) => VENDOR_SDK.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(LIB, file))
    .sort();
  assert.deepEqual(
    importers.filter((file) => !VENDOR_SDK_ALLOWED.has(file)),
    [],
    "call a model through lib/readings/models (see its README), not a vendor SDK",
  );
  // An entry nothing matches is stale: the file moved onto the kit, so take it off the list.
  assert.deepEqual(
    [...VENDOR_SDK_ALLOWED].filter((file) => !importers.includes(file)),
    [],
  );
});

test("every request a model kit adapter sends over fetch is well-formed", () => {
  // One file sends for all of them, and it makes the body well-formed before anything is signed.
  const providers = path.join(LIB, "readings", "models", "providers");
  const senders = libSources(providers).filter((file) =>
    /\b(doFetch|fetch|fetchImpl)\(/.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(
    senders.map((file) => path.basename(file)),
    ["http.ts"],
  );
  const bodies = [...readFileSync(senders[0], "utf8").matchAll(/JSON\.stringify\((\w+)\(body\)/g)];
  assert.deepEqual(
    bodies.map((match) => match[1]),
    ["wellFormedJson"],
  );
});

const VENDOR_HOST =
  /(api\.openai\.com|api\.anthropic\.com|api\.mistral\.ai|api\.x\.ai|aiplatform|generativelanguage\.googleapis|bedrock-runtime|api\.typesafe\.ai|sage\.levanto\.ai)/;

const VENDOR_HOST_ALLOWED = [
  "adapters/oss/embedding-provider.ts",
  "readings/anthropic/client.ts",
  "readings/decisions/openai.ts",
  "readings/decisions/vendors.ts",
  "readings/models/providers/claude-hosts.ts",
  "readings/models/providers/index.ts",
  "readings/models/vendors.ts",
];

test("only the vendor tables and the adapters name a vendor's address", () => {
  const naming = libSources(LIB)
    .filter((file) => {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      return VENDOR_HOST.test(code);
    })
    .map((file) => path.relative(LIB, file))
    .filter((file) => !file.startsWith("ingest/") && !file.startsWith("console/seed/"))
    .sort();
  assert.deepEqual(naming, VENDOR_HOST_ALLOWED);
});
