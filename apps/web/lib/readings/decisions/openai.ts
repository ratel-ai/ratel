/**
 * One closed-set decision ("which of these tools does this query want"),
 * answered by OpenAI's Decisions API (`POST /v1/decisions`, a `choice` question).
 *
 * The match-quality judge, Agent health's workflow decisions and Tool Picker all
 * ask the same shape of question, so the request, the tuned framing and the
 * refusal handling live here once; each surface keeps its own retry and budget
 * policy around it.
 *
 * MEASURED, 2026-10-13, on a 504-query labelled production answer key a three-model Claude
 * panel labelled blind (tuned on half, confirmed on the held-out half):
 *
 *   - One call over the whole catalog: 81.5% top-1, 52% of queries answered at
 *     confidence >= 0.8. The private judge on the same key: 85.9%, 65%.
 *   - Dropping the " | Use cases: …" keyword tail from each tool's searchable
 *     text: OpenAI over-weights long keyword lists (a 60-word tail made
 *     `update_task` win "get task details by id"). Top-5 95.6% -> 97.0%.
 *   - Asking again over the first answer's top RERANK_DEPTH options: 84.1% top-1
 *     and 66% answered at >= 0.8, at the same ~99.5% accuracy. Parity with Jev.
 *   - Did not help, all within noise: "pick the FIRST step" instructions, option
 *     shuffling, wrapping the query as data, either description alone.
 *
 * REFUSALS (~0.5-1% of queries) come from a screen that reads only the input,
 * before the options (a refusal bills ~40-90 tokens). It fires on a named person
 * plus work-tracking phrasing ("coding work history for <name> by day"), and it
 * is deterministic per wording, so re-sending the same body is pointless. What
 * works is rewording: a sentence of context in front of the same query, or the
 * name replaced by a role. `decideChoice` walks that chain, least invasive
 * first, and only then reports a refusal.
 */

export const OPENAI_DECISIONS_MODEL = "gpt-6-luna";
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com";

/** List price per input token. Output tokens are free on this endpoint. */
export const OPENAI_USD_PER_INPUT_TOKEN = 0.1 / 1_000_000;

/** Options the second pass re-reads. 5 to 8 measured the same; 8 keeps top-5 intact. */
export const RERANK_DEPTH = 8;

/** What a refusal retry calls a person, so the screen reads a role, not a name. */
const REDACTED_PERSON = "a teammate";

/** One option as the model reads it. */
export interface DecisionOption {
  id: string;
  /** What the tool does: the agent-facing description. */
  does: string;
  /** When to use it: the customer's searchable text, when it differs. */
  searchable?: string;
}

/** The situation and the question, worded per surface. */
export interface DecisionFraming {
  about: string;
  question: string;
}

export interface DecisionAnswer {
  choice: string;
  confidence: number;
  /** Every option's probability; ranks the alternatives. */
  probabilities: Record<string, number>;
}

/** `answer` is null when every wording in the chain was refused. */
export interface DecisionResult {
  answer: DecisionAnswer | null;
  inputTokens: number;
}

export type DecisionFailureReason = "credentials" | "rate_limited" | "unavailable" | "unreadable";

export class DecisionCallError extends Error {
  constructor(
    readonly reason: DecisionFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface DecisionClientConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Tries per HTTP request on a 5xx or a dropped connection. */
  attempts?: number;
  /** True waits out a 429 and retries (background work); false throws `rate_limited`. */
  retryRateLimit?: boolean;
}

interface ChoiceRequest {
  input: string;
  instructions: string;
  options: readonly DecisionOption[];
}

type RawAnswer = DecisionAnswer | "refusal";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ATTEMPTS = 3;

/** The searchable text without its keyword tail. See "MEASURED" above. */
export function withoutUseCases(text: string): string {
  const cut = text.indexOf("| Use cases:");
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

/** The option text the tuning settled on. Pure, so the shape is pinned by a test. */
export function optionDescription(option: DecisionOption): string {
  const does = option.does.trim();
  const when = option.searchable ? withoutUseCases(option.searchable) : "";
  return when && when !== does
    ? `What it does: ${does}\nWhen to use: ${when}`
    : `What it does: ${does}`;
}

/** The request body for one question. Pure, so the shape is pinned by a test. */
export function buildDecisionRequest(
  request: ChoiceRequest,
  model: string,
): Record<string, unknown> {
  return {
    model,
    input: request.input,
    questions: [
      {
        type: "choice",
        name: "tool",
        instructions: request.instructions,
        choices: request.options.map((option) => ({
          value: option.id,
          description: optionDescription(option),
        })),
      },
    ],
  };
}

/**
 * The words a search query puts in front of a person: "tasks for Patrick
 * Metzger", "commits by Ana Lima", "assigned to Sam Ortiz". Deliberately short:
 * "to", "with", "of" and "from" lead into statuses and products at least as
 * often ("move to In Progress", "export to Google Sheets") and are left out.
 */
const PERSON_LEAD_INS = [
  "assigned to",
  "owned by",
  "created by",
  "reported by",
  "updated by",
  "for",
  "by",
];

/** A capitalised word with at least one more letter: "Ana", "Zoë", "Jean-Luc", "O'Neil". Not "PATRICK". */
const NAME_WORD = "\\p{Lu}(?:\\p{Ll}+|['\u2019-]\\p{L}+)+";

/** Two or more name words: a full name. */
const FULL_NAME = `${NAME_WORD}(?:\\s+${NAME_WORD})+`;

/** "for" or "For": the lead-in as a query writes it, with either first letter. */
const anyCase = (word: string) => `[${word[0]!.toUpperCase()}${word[0]!}]${word.slice(1)}`;

/** A lead-in, then two or more name words. The lead-in is kept, the name goes. */
const PERSON_PATTERN = new RegExp(
  `\\b((?:${PERSON_LEAD_INS.map(anyCase).join("|")})\\s+)(${FULL_NAME})`,
  "gu",
);

/** A further name listed after a redacted one: "for Ana Lima and Sam Ortiz", "by Ana Lima, Sam Ortiz". */
const LISTED_PERSON_PATTERN = new RegExp(
  `(${REDACTED_PERSON}(?:,|\\s+and)\\s+)(${FULL_NAME})`,
  "gu",
);

/**
 * Everything the options say, lowercased, so a capitalised phrase the catalog
 * itself uses ("Ratel Cloud", "Due Date", "Pull Request") is known not to be a
 * person. A person's name does not appear in a tool's text.
 */
export function catalogText(options: readonly DecisionOption[]): string {
  return options
    .map((option) => `${option.id}\n${option.does}\n${option.searchable ?? ""}`)
    .join("\n")
    .toLowerCase();
}

/**
 * Replaces a person's name (two or more capitalised words right after one of the
 * `PERSON_LEAD_INS`) with a role, unless the catalog uses that phrase itself.
 * Still a heuristic: a single-word name stays. Kept narrow so that "Create Pull
 * Request", "Search Jira Tasks" and "move to In Progress" survive; it only runs
 * after a refusal, and after the context wording has been refused too.
 */
export function redactPeople(query: string, catalog = ""): string {
  const known = (phrase: string) => catalog.includes(phrase.toLowerCase());
  const redact = (match: string, before: string, name: string) =>
    known(name) ? match : `${before}${REDACTED_PERSON}`;
  let out = query.replace(PERSON_PATTERN, redact);
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = out.replace(LISTED_PERSON_PATTERN, redact);
  }
  return out;
}

/** The sentence put in front of a refused query so the screen reads a workplace, not surveillance. */
const WORKPLACE_CONTEXT =
  "Context: a workplace project-management tool. People's names appear in these queries " +
  "because they are teammates, assignees and authors in the workspace. ";

/**
 * The wordings tried in order until one is not refused, least invasive first:
 * the query as written, the query with context in front, then the same two with
 * the person's name replaced. A query without a name has only the first two.
 */
export function refusalChain(
  query: string,
  framing: DecisionFraming,
  options: readonly DecisionOption[] = [],
): ChoiceRequest[] {
  const plain = (q: string) => `${framing.about}\n\nSearch query: ${q}`;
  const contextual = (q: string) => WORKPLACE_CONTEXT + plain(q);
  const redacted = redactPeople(query, catalogText(options));
  const inputs = [plain(query), contextual(query)];
  if (redacted !== query) inputs.push(plain(redacted), contextual(redacted));
  return inputs.map((input) => ({ input, instructions: framing.question, options: [] }));
}

export function decisionClient(config: DecisionClientConfig) {
  const endpoint = `${(config.baseUrl || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, "")}/v1/decisions`;
  const model = config.model || OPENAI_DECISIONS_MODEL;
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(1, config.attempts ?? DEFAULT_ATTEMPTS);

  /** One HTTP question. Throws `DecisionCallError`; a refusal is an answer, not an error. */
  async function ask(request: ChoiceRequest): Promise<{ answer: RawAnswer; inputTokens: number }> {
    const body = JSON.stringify(buildDecisionRequest(request, model));
    let lastFailure: DecisionCallError | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(Math.min(500 * 2 ** attempt, 8_000));
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastFailure = new DecisionCallError("unavailable", "OpenAI decision request failed", {
          cause: err,
        });
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        throw new DecisionCallError(
          "credentials",
          `OpenAI rejected the API key (${response.status})`,
        );
      }
      if (response.status === 429) {
        await response.body?.cancel().catch(() => {});
        if (!config.retryRateLimit)
          throw new DecisionCallError("rate_limited", "OpenAI rate limited the request");
        lastFailure = new DecisionCallError("rate_limited", "OpenAI rate limited the request");
        await sleep(retryAfterMs(response, attempt));
        continue;
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        lastFailure = new DecisionCallError(
          "unavailable",
          `OpenAI returned ${response.status}: ${detail.slice(0, 200)}`,
        );
        // A 4xx is our request's shape and will not change on a retry.
        if (response.status < 500) break;
        continue;
      }
      try {
        return readAnswer((await response.json()) as DecisionsResponse, body);
      } catch (err) {
        lastFailure = new DecisionCallError(
          "unreadable",
          "OpenAI decision response was unreadable",
          { cause: err },
        );
      }
    }
    throw lastFailure ?? new DecisionCallError("unavailable", "OpenAI did not answer");
  }

  /**
   * The tuned decision: whole option set, then a second look at its top
   * RERANK_DEPTH, walking the refusal chain for the first pass. Tokens of every
   * call (refused ones included) are counted, because every call is billed.
   */
  async function decideChoice(
    query: string,
    options: readonly DecisionOption[],
    framing: DecisionFraming,
  ): Promise<DecisionResult> {
    let inputTokens = 0;
    let first: DecisionAnswer | null = null;
    let wording: ChoiceRequest | null = null;
    for (const candidate of refusalChain(query, framing, options)) {
      const request = { ...candidate, options };
      const asked = await ask(request);
      inputTokens += asked.inputTokens;
      if (asked.answer !== "refusal") {
        first = asked.answer;
        wording = request;
        break;
      }
    }
    if (!first || !wording) return { answer: null, inputTokens };
    assertOffered(first, options);
    if (options.length <= RERANK_DEPTH) return { answer: first, inputTokens };

    const top = new Set(topIds(first, RERANK_DEPTH));
    // Without probabilities the first answer names only its own choice, and a
    // one-option question cannot change anything.
    if (top.size < 2) return { answer: first, inputTokens };
    // Same neutral order as the first pass, only fewer options.
    const second = await ask({
      ...wording,
      options: options.filter((option) => top.has(option.id)),
    });
    inputTokens += second.inputTokens;
    if (second.answer === "refusal") return { answer: first, inputTokens };
    assertOffered(second.answer, options);
    return { answer: mergeRerank(first, second.answer), inputTokens };
  }

  return { model, ask, decideChoice };
}

export type DecisionClient = ReturnType<typeof decisionClient>;

interface DecisionsResponse {
  answers?: Array<{
    type?: string;
    name?: string;
    choice?: unknown;
    confidence?: unknown;
    probabilities?: Array<{ value?: unknown; probability?: unknown }>;
  }>;
  usage?: { input_tokens?: number };
}

function readAnswer(
  parsed: DecisionsResponse,
  body: string,
): { answer: RawAnswer; inputTokens: number } {
  const inputTokens = parsed.usage?.input_tokens ?? Math.ceil(body.length / 3);
  const answer = parsed.answers?.find((candidate) => candidate.name === "tool");
  if (answer?.type === "refusal") return { answer: "refusal", inputTokens };
  if (!answer || typeof answer.choice !== "string" || typeof answer.confidence !== "number") {
    throw new Error("OpenAI response carried no choice answer");
  }
  const probabilities: Record<string, number> = {};
  for (const entry of answer.probabilities ?? []) {
    if (typeof entry.value === "string" && typeof entry.probability === "number") {
      probabilities[entry.value] = entry.probability;
    }
  }
  return {
    answer: { choice: answer.choice, confidence: answer.confidence, probabilities },
    inputTokens,
  };
}

function assertOffered(answer: DecisionAnswer, options: readonly DecisionOption[]): void {
  if (!options.some((option) => option.id === answer.choice)) {
    throw new DecisionCallError("unreadable", "OpenAI chose an option that was not offered");
  }
}

/** The answer's choice first, then the rest by probability. */
function topIds(answer: DecisionAnswer, depth: number): string[] {
  const rest = Object.entries(answer.probabilities)
    .filter(([id]) => id !== answer.choice)
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => id);
  return [answer.choice, ...rest].slice(0, depth);
}

/**
 * The second pass decides the order of the options it re-read; everything the
 * first pass left out ranks after them, in first-pass order. Scores below the
 * re-read set are scaled under its smallest one, so they rank but never outrank.
 */
export function mergeRerank(first: DecisionAnswer, second: DecisionAnswer): DecisionAnswer {
  const reread = second.probabilities;
  const floor = Math.min(...Object.values(reread).filter((value) => value > 0), 1);
  const outside = Object.entries(first.probabilities).filter(([id]) => !(id in reread));
  const peak = Math.max(...outside.map(([, value]) => value), 0);
  const scale = peak > 0 ? floor / 2 / peak : 0;
  return {
    choice: second.choice,
    confidence: second.confidence,
    probabilities: {
      ...Object.fromEntries(outside.map(([id, value]) => [id, value * scale])),
      ...reread,
    },
  };
}

function retryAfterMs(response: Response, attempt: number): number {
  const seconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
  return Math.min(500 * 2 ** attempt, 8_000);
}
