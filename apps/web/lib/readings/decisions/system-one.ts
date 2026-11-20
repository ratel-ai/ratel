import type {
  DecisionCapabilities,
  DecisionClient,
  DecisionFraming,
  DecisionOption,
  DecisionResult,
} from "@/lib/contracts/models";
import type { ModelCallPayer } from "@/lib/contracts/telemetry";
import { trackModelCall } from "@/lib/platform/model-call";
import { wellFormedJson } from "@/lib/readings/text/well-formed";
import { DEFAULT_DECISION_FEATURE, DecisionCallError, optionDescription } from "./openai";

/**
 * One closed-set decision answered by a server that speaks the System One wire format
 * (`POST {base}/v1/systemone`, a `choice` question), ADR-0033 §9:
 *
 *   request  { model, state, questions: { tool: { type: "choice", instructions, criteria: { t0: "…" } } } }
 *   response { answers: { tool: { type: "choice", probabilities: { t0: 0.9 } } }, usage? }
 *
 * It is the format the SDK's ranker plugin speaks (`src/rankers`). Nothing here names a vendor:
 * the deployment gives the base URL, the model and the key (`DECISION_BASE_URL`,
 * `DECISION_MODEL`, `DECISION_API_KEY`), so it runs against whichever server speaks it.
 *
 * The options go as index keys (`t0`…), not ids: an id may be long or odd, and the key is part
 * of what the model reads. The option text is the one the OpenAI engine settled on.
 *
 * What it can be relied on for is declared as a score, not a calibrated probability: an engine
 * is trusted for a surface only after the judge benchmark has run on it, and until then the
 * judge holds it to a stricter threshold (`DECISION_MIN_CONFIDENCE` sets it once measured).
 */

export const SYSTEM_ONE_PROVIDER = "system-one";
export const SYSTEM_ONE_MAX_OPTIONS = 150;

/** The one question's name, as the OpenAI engine names it. */
const QUESTION = "tool";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ATTEMPTS = 3;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;

export const SYSTEM_ONE_CAPABILITIES: DecisionCapabilities = {
  refusals: false,
  confidence: "score",
  maxOptions: SYSTEM_ONE_MAX_OPTIONS,
};

export interface SystemOneConfig {
  baseUrl: string;
  model: string;
  /** Absent for a server that asks for none. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Tries per question on a 5xx or a dropped connection. */
  attempts?: number;
  /** True waits out a 429 and retries (background work); false throws `rate_limited`. */
  retryRateLimit?: boolean;
  /** What the questions are for, on each `model_call` log line. */
  feature?: string;
  payer?: ModelCallPayer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function retryAfterMs(response: Response, attempt: number): number {
  const seconds = Number(response.headers.get("retry-after"));
  const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt;
  return Math.min(wait, MAX_RATE_LIMIT_WAIT_MS);
}

/** The answer to the one question, mapped back from index keys to the options' ids. */
function readAnswer(
  data: unknown,
  options: readonly DecisionOption[],
  body: string,
): DecisionResult {
  const answers = isRecord(data) ? data.answers : undefined;
  const answer = isRecord(answers) ? answers[QUESTION] : undefined;
  const raw = isRecord(answer) ? answer.probabilities : undefined;
  if (!isRecord(answer) || !isRecord(raw)) throw new Error("no answer to the question");

  const probabilities: Record<string, number> = {};
  let best = -1;
  options.forEach((option, index) => {
    const value = raw[`t${index}`];
    const probability =
      typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    probabilities[option.id] = probability;
    if (best === -1 || probability > probabilities[options[best].id]) best = index;
  });

  // A server may name its own choice and confidence; without them, the likeliest option.
  const named = typeof answer.choice === "string" ? /^t(\d+)$/.exec(answer.choice) : null;
  const chosen = named && options[Number(named[1])] ? Number(named[1]) : best;
  const choice = options[chosen].id;
  const confidence =
    typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
      ? answer.confidence
      : probabilities[choice];

  const usage = isRecord(data) && isRecord(data.usage) ? data.usage.input_tokens : undefined;
  return {
    answer: { choice, confidence, probabilities },
    // A server that reports no usage still moves the budget, at about 3.5 characters a token.
    inputTokens: typeof usage === "number" ? usage : Math.ceil(body.length / 3.5),
  };
}

export function systemOneClient(config: SystemOneConfig): DecisionClient {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(1, config.attempts ?? DEFAULT_ATTEMPTS);
  const meta = {
    provider: SYSTEM_ONE_PROVIDER,
    model: config.model,
    feature: config.feature ?? DEFAULT_DECISION_FEATURE,
    payer: config.payer ?? ("ratel" as const),
  };

  /** One question over HTTP. Throws `DecisionCallError`. */
  async function askOnce(
    query: string,
    options: readonly DecisionOption[],
    framing: DecisionFraming,
  ): Promise<DecisionResult> {
    const body = JSON.stringify(
      wellFormedJson({
        model: config.model,
        state: `${framing.about}\n\nSearch query: ${query}`,
        questions: {
          [QUESTION]: {
            type: "choice",
            instructions: framing.question,
            criteria: Object.fromEntries(
              options.map((option, index) => [`t${index}`, optionDescription(option)]),
            ),
          },
        },
      }),
    );
    let lastFailure: DecisionCallError | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(Math.min(500 * 2 ** attempt, 8_000));
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastFailure = new DecisionCallError("unavailable", "the decision request failed", {
          cause: err,
        });
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        throw new DecisionCallError(
          "credentials",
          `the decision engine rejected the API key (${response.status})`,
        );
      }
      if (response.status === 429) {
        await response.body?.cancel().catch(() => {});
        lastFailure = new DecisionCallError(
          "rate_limited",
          "the decision engine rate limited the request",
        );
        if (!config.retryRateLimit) throw lastFailure;
        await sleep(retryAfterMs(response, attempt));
        continue;
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        lastFailure = new DecisionCallError(
          "unavailable",
          `the decision engine returned ${response.status}: ${detail.slice(0, 200)}`,
        );
        // A 4xx is our request's shape, or a plan's usage running out: a retry will not change it.
        if (response.status < 500) break;
        continue;
      }
      try {
        return readAnswer(await response.json(), options, body);
      } catch (err) {
        lastFailure = new DecisionCallError("unreadable", "the decision answer was unreadable", {
          cause: err,
        });
      }
    }
    throw lastFailure ?? new DecisionCallError("unavailable", "the decision engine did not answer");
  }

  return {
    model: config.model,
    capabilities: SYSTEM_ONE_CAPABILITIES,
    async decideChoice(query, options, framing) {
      // One option needs no model, and the format takes at least two.
      if (options.length === 1) {
        const only = options[0].id;
        return {
          answer: { choice: only, confidence: 1, probabilities: { [only]: 1 } },
          inputTokens: 0,
        };
      }
      return trackModelCall(
        meta,
        () => askOnce(query, options, framing),
        (result) => ({ inputTokens: result.inputTokens }),
      );
    },
  };
}
