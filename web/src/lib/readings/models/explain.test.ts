import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic, { type PermissionDeniedError } from "@anthropic-ai/sdk";
import { resolveConfig } from "@/config";
import { ModelNotEnabledError } from "@/lib/platform/anthropic-errors";
import { resolveDecisionEngine } from "@/lib/readings/decisions/engine";
import { DecisionCallError } from "@/lib/readings/decisions/openai";
import { resolveModelVendor } from "./config";
import {
  explainDecisionSetup,
  explainEmbeddingSetup,
  explainModelError,
  explainTextSetup,
  setupLines,
} from "./explain";
import { ModelHttpError } from "./providers/http";

const cfg = (env: Record<string, string | undefined> = {}) => resolveConfig({ env });
const KEY = "sk-secret-value-1234567890";

/* - Setup ------------------------------------------------------------------ */

const TEXT_CASES: Array<[Record<string, string>, RegExp | null]> = [
  [{}, /no text model.*MODEL_PROVIDER.*ANTHROPIC_API_KEY/i],
  [{ ANTHROPIC_API_KEY: KEY }, null],
  [{ ANTHROPIC_API_KEY: "REPLACE_ME" }, /ANTHROPIC_API_KEY/],
  [{ ANTHROPIC_BACKEND: "bedrok", ANTHROPIC_API_KEY: KEY }, /ANTHROPIC_BACKEND=bedrok.*bedrock/],
  [{ ANTHROPIC_BACKEND: "bedrock" }, null],
  [{ ANTHROPIC_BACKEND: "bedrock", AWS_BEARER_TOKEN_BEDROCK: "t" }, /AWS_BEARER_TOKEN_BEDROCK/],
  [{ MODEL_PROVIDER: "bedrok" }, /MODEL_PROVIDER=bedrok is not a vendor.*bedrock/],
  [{ MODEL_PROVIDER: "claude" }, /ANTHROPIC_API_KEY/],
  [{ MODEL_PROVIDER: "openai" }, /OPENAI_API_KEY/],
  [{ MODEL_PROVIDER: "openai", OPENAI_API_KEY: KEY }, null],
  [
    { MODEL_PROVIDER: "openai", OPENAI_API_KEY: KEY, MODEL_BASE_URL: "https://gw.test/v1" },
    /MODEL_API_KEY/,
  ],
  [{ MODEL_PROVIDER: "openai", MODEL_BASE_URL: "nope", MODEL_API_KEY: KEY }, /MODEL_BASE_URL/],
  [{ MODEL_PROVIDER: "gcp", GOOGLE_CLOUD_LOCATION: "eu" }, /GOOGLE_CLOUD_PROJECT/],
  [{ MODEL_PROVIDER: "gcp", GOOGLE_CLOUD_PROJECT: "acme" }, /GOOGLE_CLOUD_LOCATION/],
  [
    { MODEL_PROVIDER: "gcp", GOOGLE_CLOUD_PROJECT: "a/b", GOOGLE_CLOUD_LOCATION: "eu" },
    /GOOGLE_CLOUD_PROJECT/,
  ],
  [{ MODEL_PROVIDER: "gcp", GOOGLE_CLOUD_PROJECT: "acme", GOOGLE_CLOUD_LOCATION: "eu" }, null],
  [{ MODEL_PROVIDER: "bedrock" }, /AWS_REGION/],
  [{ MODEL_PROVIDER: "bedrock", AWS_REGION: "sa-east-1" }, /BEDROCK_PROFILE/],
  [
    { MODEL_PROVIDER: "bedrock", AWS_REGION: "eu-west-1", BEDROCK_PROFILE: "mars" },
    /BEDROCK_PROFILE/,
  ],
  [{ MODEL_PROVIDER: "bedrock", AWS_REGION: "eu-west-1" }, null],
  [{ MODEL_PROVIDER: "ollama" }, /MODEL_BASE_URL/],
  [{ MODEL_PROVIDER: "ollama", MODEL_BASE_URL: "box:11434" }, /MODEL_BASE_URL/],
  [{ MODEL_PROVIDER: "ollama", MODEL_BASE_URL: "http://box:11434" }, null],
  [{ MODEL_PROVIDER: "custom", MODEL_BASE_URL: "http://box/v1" }, null],
  [{ MODEL_PROVIDER: "fake" }, /local/],
];

test("the text setup says why there is no model, exactly when the kit has none", () => {
  for (const [env, why] of TEXT_CASES) {
    const config = cfg(env);
    const setup = explainTextSetup(config, "production");
    const label = JSON.stringify(env);
    assert.equal(setup.on, resolveModelVendor(config, "production") !== null, label);
    if (why) assert.match(setup.reason ?? "", why, label);
    else assert.equal(setup.reason, undefined, label);
  }
});

test("the text setup names the model of each feature, and says which have none", () => {
  const setup = explainTextSetup(
    cfg({
      MODEL_PROVIDER: "ollama",
      MODEL_BASE_URL: "http://box:11434",
      MODEL_FEATURE_EVAL_GATE_REPLAY: "qwen3:32b",
    }),
    "production",
  );
  assert.equal(setup.vendor, "Ollama");
  assert.equal(setup.where, "http://box:11434/v1");
  const replay = setup.features.find((row) => row.feature === "eval_gate_replay");
  assert.equal(replay?.model, "qwen3:32b");
  const label = setup.features.find((row) => row.feature === "workflow_label");
  assert.equal(label?.model, null);
  assert.match(label?.reason ?? "", /MODEL\b.*MODEL_FEATURE_WORKFLOW_LABEL/);
});

test("a known vendor's defaults fill every feature", () => {
  const setup = explainTextSetup(cfg({ ANTHROPIC_API_KEY: KEY }), "production");
  assert.equal(setup.vendor, "Claude");
  assert.ok(setup.features.length > 0);
  for (const row of setup.features) assert.match(row.model ?? "", /^claude-/, row.feature);
});

test("an address shown never carries its credentials", () => {
  const setup = explainTextSetup(
    cfg({ MODEL_PROVIDER: "litellm", MODEL_BASE_URL: "https://user:pass@gw.test" }),
    "production",
  );
  assert.equal(setup.where, "https://gw.test/v1");
});

const DECISION_CASES: Array<[Record<string, string>, RegExp | null]> = [
  [{}, /no decision model.*DECISION_PROVIDER.*OPENAI_API_KEY/i],
  [{ OPENAI_API_KEY: KEY }, null],
  [{ DECISION_PROVIDER: "sage" }, /DECISION_PROVIDER=sage is not a vendor.*levanto/],
  [{ DECISION_PROVIDER: "levanto" }, /SAGE_API_KEY/],
  [{ DECISION_PROVIDER: "levanto", SAGE_API_KEY: KEY }, null],
  [{ DECISION_PROVIDER: "typesafe" }, /TYPESAFE_API_KEY/],
  [{ DECISION_PROVIDER: "google" }, /GEMINI_API_KEY/],
  [
    { DECISION_PROVIDER: "levanto", SAGE_API_KEY: KEY, DECISION_BASE_URL: "https://x.test" },
    /DECISION_API_KEY/,
  ],
  [{ DECISION_PROVIDER: "custom" }, /DECISION_BASE_URL/],
  [{ DECISION_PROVIDER: "custom", DECISION_BASE_URL: "https://x.test" }, /DECISION_MODEL/],
  [{ DECISION_PROVIDER: "custom", DECISION_BASE_URL: "https://x.test", DECISION_MODEL: "m" }, null],
];

test("the decision setup says why there is none, exactly when there is none", () => {
  for (const [env, why] of DECISION_CASES) {
    const config = cfg(env);
    const setup = explainDecisionSetup(config);
    const label = JSON.stringify(env);
    assert.equal(setup.on, resolveDecisionEngine(config) !== null, label);
    if (why) assert.match(setup.reason ?? "", why, label);
    else assert.equal(setup.reason, undefined, label);
  }
  const sage = explainDecisionSetup(cfg({ DECISION_PROVIDER: "levanto", SAGE_API_KEY: KEY }));
  assert.equal(sage.vendor, "Levanto (Sage)");
  assert.equal(sage.model, "levanto-sage-2");
});

test("embeddings are always on: a server, OpenAI, or the local hash", () => {
  assert.match(explainEmbeddingSetup(cfg({})).vendor ?? "", /local/i);
  assert.equal(explainEmbeddingSetup(cfg({ OPENAI_API_KEY: KEY })).vendor, "OpenAI");
  const own = explainEmbeddingSetup(
    cfg({ EMBEDDING_BASE_URL: "http://box:11434/v1", EMBEDDING_MODEL: "all-minilm" }),
  );
  assert.equal(own.where, "http://box:11434/v1");
  assert.equal(own.model, "all-minilm");
});

test("the startup lines are one per kind, with no key in them", () => {
  const config = cfg({
    MODEL_PROVIDER: "bedrok",
    DECISION_PROVIDER: "levanto",
    SAGE_API_KEY: KEY,
    OPENAI_API_KEY: KEY,
  });
  const lines = setupLines(config, "production");
  assert.equal(lines.length, 3);
  assert.equal(lines[0].level, "warn");
  assert.match(lines[0].message, /^text models: off: MODEL_PROVIDER=bedrok/);
  assert.match(lines[1].message, /^decision model: Levanto \(Sage\), levanto-sage-2 at https/);
  assert.match(lines[2].message, /^embeddings: OpenAI/);
  for (const line of lines) assert.ok(!line.message.includes(KEY));
});

/* - Errors ----------------------------------------------------------------- */

const at = (env: Record<string, string>) => ({ config: cfg(env), environment: "production" });
const OPENAI = { MODEL_PROVIDER: "openai", OPENAI_API_KEY: KEY };
const GCP = { MODEL_PROVIDER: "gcp", GOOGLE_CLOUD_PROJECT: "acme", GOOGLE_CLOUD_LOCATION: "eu" };
const BEDROCK = { MODEL_PROVIDER: "bedrock", AWS_REGION: "eu-central-1" };
const OLLAMA = { MODEL_PROVIDER: "ollama", MODEL_BASE_URL: "http://ollama:11434" };

const call = (feature: string, model: string, error: unknown) => ({ feature, model, error });

function anthropicError(status: number, message: string) {
  return Anthropic.APIError.generate(status, { error: { message } }, message, new Headers());
}

test("a refused key names the variable it came from", () => {
  const sentence = explainModelError(
    call("workflow_label", "gpt-6.2-sol", new ModelHttpError(401, `OpenAI answered 401: ${KEY}`)),
    at(OPENAI),
  );
  assert.match(sentence, /OpenAI refused the key in OPENAI_API_KEY \(401\)/);
  assert.ok(!sentence.includes(KEY));
  assert.match(
    explainModelError(
      call("workflow_label", "m", new ModelHttpError(401, "no")),
      at({ ...OPENAI, MODEL_API_KEY: "k", MODEL_BASE_URL: "https://gw.test/v1" }),
    ),
    /MODEL_API_KEY/,
  );
  assert.match(
    explainModelError(
      call("workflow_label", "claude-sonnet-5-5", anthropicError(401, "invalid x-api-key")),
      at({ ANTHROPIC_API_KEY: KEY }),
    ),
    /Claude refused the key in ANTHROPIC_API_KEY \(401\)/,
  );
});

test("a model the account may not use says where to enable it", () => {
  const notAvailable = anthropicError(
    403,
    "anthropic.claude-sonnet-5-5 is not available for this account. contact AWS Sales",
  );
  assert.match(
    explainModelError(call("workflow_label", "claude-sonnet-5-5", notAvailable), at(BEDROCK)),
    /Bedrock won't run claude-sonnet-5-5 for this AWS account in eu-central-1 \(403\)/,
  );
  const marketplace = new ModelNotEnabledError(
    "claude-sonnet-5-5",
    "eu",
    anthropicError(403, "aws-marketplace:Subscribe") as PermissionDeniedError,
  );
  assert.match(
    explainModelError(
      call("workflow_label", "claude-sonnet-5-5", marketplace),
      at({ ANTHROPIC_BACKEND: "bedrock" }),
    ),
    /Bedrock won't run claude-sonnet-5-5 for this AWS account/,
  );
});

test("a model that is not there names the model setting and the place", () => {
  const sentence = explainModelError(
    call("eval_gate_replay", "claude-opus-5-5", anthropicError(404, "Publisher model not found")),
    at(GCP),
  );
  assert.match(
    sentence,
    /Google Cloud \(Vertex AI\) has no model claude-opus-5-5 in GOOGLE_CLOUD_LOCATION=eu \(404\)/,
  );
  assert.match(sentence, /Model Garden/);
  assert.match(sentence, /MODEL_FEATURE_EVAL_GATE_REPLAY/);
});

test("quota, server errors, bad requests and unreadable answers each have their sentence", () => {
  assert.match(
    explainModelError(
      call("workflow_label", "m", new ModelHttpError(429, "slow down")),
      at(OPENAI),
    ),
    /rate limit|quota/i,
  );
  assert.match(
    explainModelError(call("workflow_label", "m", new ModelHttpError(503, "busy")), at(OPENAI)),
    /server error \(503\)/,
  );
  assert.match(
    explainModelError(call("workflow_label", "m", new ModelHttpError(400, "bad")), at(OPENAI)),
    /rejected the request for m \(400\)/,
  );
});

test("an address that does not answer, and a call that timed out", () => {
  const refused = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
  assert.match(
    explainModelError(call("workflow_label", "llama3.3", refused), at(OLLAMA)),
    /couldn't reach Ollama at MODEL_BASE_URL=http:\/\/ollama:11434\/v1/,
  );
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.match(
    explainModelError(call("workflow_label", "llama3.3", timeout), at(OLLAMA)),
    /didn't answer in time/,
  );
  assert.match(
    explainModelError(
      call("workflow_label", "claude-sonnet-5-5", new Anthropic.APIConnectionError({})),
      at({ ANTHROPIC_API_KEY: KEY }),
    ),
    /couldn't reach Claude/,
  );
});

test("an expired cloud login says how to sign in again", () => {
  const google = Object.assign(
    new Error(
      '{"error":"invalid_grant","error_description":"reauth related error (invalid_rapt)"}',
    ),
    {
      name: "GaxiosError",
    },
  );
  assert.match(
    explainModelError(call("workflow_label", "gemini-4-carbon", google), at(GCP)),
    /Google login.*expired.*gcloud auth application-default login/,
  );
  const aws = Object.assign(new Error("Could not load credentials from any providers"), {
    name: "CredentialsProviderError",
  });
  assert.match(
    explainModelError(call("workflow_label", "claude-sonnet-5-5", aws), at(BEDROCK)),
    /AWS login.*missing or expired/,
  );
});

test("a decision error names the decision vendor's settings", () => {
  const sage = { DECISION_PROVIDER: "levanto", SAGE_API_KEY: KEY };
  assert.match(
    explainModelError(
      call(
        "match_quality_judge",
        "levanto-sage-2",
        new DecisionCallError("credentials", "x (401)", { status: 401 }),
      ),
      at(sage),
    ),
    /Levanto \(Sage\) refused the key in SAGE_API_KEY \(401\)/,
  );
  assert.match(
    explainModelError(
      call(
        "topics_place",
        "levanto-sage-2",
        new DecisionCallError("unavailable", "x", { status: 404 }),
      ),
      at(sage),
    ),
    /no model levanto-sage-2.*DECISION_MODEL/,
  );
  assert.match(
    explainModelError(
      call(
        "topics_place",
        "levanto-sage-2",
        new DecisionCallError("unavailable", "failed", { cause: new TypeError("fetch failed") }),
      ),
      at(sage),
    ),
    /couldn't reach Levanto \(Sage\) at https:\/\/sage\.levanto\.ai/,
  );
  assert.match(
    explainModelError(
      call(
        "topics_place",
        "levanto-sage-99",
        new DecisionCallError("unavailable", "x", { status: 422 }),
      ),
      at(sage),
    ),
    /rejected the request for levanto-sage-99 \(422\)\. It may not serve that model: check DECISION_MODEL/,
  );
});

test("an error nobody named still says who and what, and never the provider's words", () => {
  const sentence = explainModelError(
    call("workflow_label", "gpt-6.2-sol", new RangeError(`odd ${KEY}`)),
    at(OPENAI),
  );
  assert.match(sentence, /OpenAI failed calling gpt-6\.2-sol \(RangeError\)/);
  assert.ok(!sentence.includes(KEY));
});

test("a sentence starts with a capital, whoever it names", () => {
  const sentence = explainModelError(
    {
      feature: "embeddings",
      model: "all-minilm",
      error: new TypeError("fetch failed"),
      kind: "embedding",
    },
    at({ EMBEDDING_BASE_URL: "http://box:11434/v1" }),
  );
  assert.match(
    sentence,
    /^Ratel couldn't reach the embedding server at EMBEDDING_BASE_URL=http:\/\/box:11434\/v1/,
  );
  assert.match(
    explainModelError(
      {
        feature: "embeddings",
        model: "all-minilm",
        error: new ModelHttpError(401, "x"),
        kind: "embedding",
      },
      at({ EMBEDDING_BASE_URL: "http://box:11434/v1", EMBEDDING_API_KEY: "k" }),
    ),
    /^The embedding server refused the key in EMBEDDING_API_KEY \(401\)/,
  );
});

test("Bedrock with no AWS login says so, not that it cannot be reached", () => {
  const error = new Anthropic.APIConnectionError({
    message: "Failed to resolve AWS credentials from the credential provider chain.",
  });
  assert.match(
    explainModelError(
      { feature: "workflow_label", model: "claude-sonnet-5-5", error },
      at(BEDROCK),
    ),
    /^The AWS login is missing or expired/,
  );
});
