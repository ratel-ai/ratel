/** A fetch that replays scripted responses in order and records every request. */
export function scriptedFetch(responses: Array<Response | Error>) {
  const calls: Array<{
    url: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** An OpenAI Decisions response choosing `choice` with the given probabilities. */
export function choiceResponse(
  choice: string,
  probabilities: Record<string, number>,
  inputTokens = 100,
): Response {
  return Response.json({
    model: "gpt-6-luna",
    answers: [
      {
        type: "choice",
        name: "tool",
        choice,
        confidence: probabilities[choice] ?? 0,
        probabilities: Object.entries(probabilities).map(([value, probability]) => ({
          value,
          probability,
        })),
      },
    ],
    usage: { input_tokens: inputTokens },
  });
}

export function refusalResponse(inputTokens = 46): Response {
  return Response.json({
    model: "gpt-6-luna",
    answers: [{ type: "refusal", name: "tool" }],
    usage: { input_tokens: inputTokens },
  });
}

export const noSleep = async () => {};
