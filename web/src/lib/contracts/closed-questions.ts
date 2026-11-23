/**
 * Closed questions (yes/no, choice) about one piece of content, each answered
 * with a probability: the contract of a question engine an edition may supply
 * (ADR-0004). The core has no engine of its own: without the port, or with one
 * that is not configured, nothing is asked and a reading stays rule-only.
 *
 * Owned: the contract half of upstream's decision client (the request, answer
 * and usage types, the failure, the request sizing). The HTTP client, its
 * key and its endpoint live in the edition, behind {@link ClosedQuestionsPort}.
 *
 * What a client guarantees and the core relies on:
 *   - A null answer is an abstention: the question was read and billed. It is
 *     an answer here (`answer: null`), never an error, and is not asked again.
 *   - A failure is a {@link ClosedQuestionError} with its reason. `unavailable`
 *     is never a credentials problem.
 *   - The whole request must fit {@link CLOSED_QUESTION_MAX_REQUEST_TOKENS} and
 *     is never truncated. Requests are sized here before they are sent, and
 *     one that cannot fit is refused without a call.
 *   - Billing: each question reads its content once, so a batch saves round
 *     trips, not tokens. Output is billed only when the model reasons; an
 *     answer itself is free.
 *   - `reasoning` is `off` unless asked for. On a batch it is one setting for
 *     every question, so questions that may reason go in their own batch.
 */

/**
 * The most one request may hold, in estimated tokens. The estimate is rough
 * and long content can be refused before the engine's limit, so requests stay
 * well under it.
 */
export const CLOSED_QUESTION_MAX_REQUEST_TOKENS = 24_000;

/** Contents per batch call, however small they are. */
export const CLOSED_QUESTION_MAX_BATCH_REQUESTS = 16;

export type ClosedQuestionReasoning = "off" | "auto";

export interface ClosedQuestionOption {
  option: string;
  description?: string;
}

export type ClosedQuestion =
  | { kind: "yesno"; id: string; instructions: string }
  | {
      kind: "choice";
      id: string;
      instructions: string;
      options: readonly ClosedQuestionOption[];
    };

export interface ClosedQuestionRequest {
  content: string;
  questions: readonly ClosedQuestion[];
}

/** One question's answer. */
export interface ClosedQuestionAnswer {
  id: string;
  /** `yes` or `no`, or the chosen option; null when the model abstained. */
  answer: string | null;
  /** Yes/no: P(yes), given even on an abstention. Choice: P(the chosen option), null on an abstention. */
  probability: number | null;
  /** The model reasoned before answering (billed as output). */
  reasoned: boolean;
}

export interface ClosedQuestionResult {
  /**
   * By request, then by question, in the order sent. An entry is null when
   * the engine could not answer that one question: the rest of the batch
   * stands.
   */
  answers: (ClosedQuestionAnswer | null)[][];
  inputTokens: number;
  outputTokens: number;
}

/**
 * `credentials`: the key is missing or wrong. `unavailable`: the plan's usage
 * is used up, the service is loading or busy or the connection dropped.
 * `invalid`: the request itself was refused or would not fit; sending it again
 * cannot work.
 */
export type ClosedQuestionFailureReason = "credentials" | "unavailable" | "invalid";

export class ClosedQuestionError extends Error {
  constructor(
    readonly reason: ClosedQuestionFailureReason,
    message: string,
    /** The HTTP status, when the server answered. */
    readonly status: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface ClosedQuestionClient {
  /** The model that answers; the answer cache keeps it beside each answer. */
  readonly model: string;
  /** One question about one content. */
  decide(
    content: string,
    question: ClosedQuestion,
    reasoning?: ClosedQuestionReasoning,
  ): Promise<ClosedQuestionAnswer>;
  /** Several contents, each with its questions, in one call. */
  decideBatch(
    requests: readonly ClosedQuestionRequest[],
    reasoning?: ClosedQuestionReasoning,
  ): Promise<ClosedQuestionResult>;
}

/** What a caller says about its questions; the edition's client puts it on each model-call record. */
export interface ClosedQuestionClientOptions {
  /** What the questions are for. */
  feature?: string;
  projectId?: string | null;
}

/**
 * The question engine an edition supplies (`CompositionPorts.closedQuestions`).
 * Absent in the open-source edition. The edition's client records each call
 * through the core's model-call seam (`lib/platform/model-call.ts`).
 */
export type ClosedQuestionsPort = {
  /** Whether the engine has what it needs to answer (the edition's key). False means no client and no call. */
  configured(): boolean;
  /** A client for these questions, or null when the engine is not configured. */
  client(options?: ClosedQuestionClientOptions): ClosedQuestionClient | null;
};

/** Tokens in a text, roughly: four characters each, as the harness that measured the questions counted. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const questionText = (question: ClosedQuestion): string =>
  question.kind === "choice"
    ? `${question.instructions}\n${question.options.map((option) => `${option.option}: ${option.description ?? ""}`).join("\n")}`
    : question.instructions;

/** Input tokens one question is billed, roughly: it reads its content once, and its own wording. */
export function estimateQuestionTokens(content: string, question: ClosedQuestion): number {
  return estimateTokens(content) + estimateTokens(questionText(question));
}

/** Input tokens a request is billed, roughly: every question reads the content. */
export function estimateRequestTokens(request: ClosedQuestionRequest): number {
  return request.questions.reduce(
    (total, question) => total + estimateQuestionTokens(request.content, question),
    0,
  );
}

/**
 * Requests packed into batches that each fit one call: at most
 * {@link CLOSED_QUESTION_MAX_BATCH_REQUESTS} contents and {@link CLOSED_QUESTION_MAX_REQUEST_TOKENS}
 * estimated tokens, in the order given. A request too large to fit alone is a
 * batch of its own, which the client refuses without a call.
 */
export function packBatches<T extends ClosedQuestionRequest>(
  requests: readonly T[],
  maxTokens: number = CLOSED_QUESTION_MAX_REQUEST_TOKENS,
): T[][] {
  const batches: T[][] = [];
  let open: T[] = [];
  let tokens = 0;
  for (const request of requests) {
    const size = estimateRequestTokens(request);
    if (
      open.length > 0 &&
      (open.length >= CLOSED_QUESTION_MAX_BATCH_REQUESTS || tokens + size > maxTokens)
    ) {
      batches.push(open);
      open = [];
      tokens = 0;
    }
    open.push(request);
    tokens += size;
  }
  if (open.length > 0) batches.push(open);
  return batches;
}
