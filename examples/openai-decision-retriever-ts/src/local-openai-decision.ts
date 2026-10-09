// A local stand-in for OpenAI's `POST /v1/decisions`, so the example runs with
// no OpenAI key. It speaks the Decisions wire format:
//
//   request  { model, input, questions: [{ type: "choice", name: "tool", instructions,
//              choices: [{ value: "t0", description: "…" }, …] }] }
//   response { answers: [{ type: "choice", name: "tool", choice: "t3",
//              probabilities: [{ value: "t0", probability: 0.01 }, …], confidence }] }
//
// (The question name is the kind being ranked: "tool" here, "skill" for skills.)
// Its "judge" is a hard-coded intent table: it shows the plumbing, not ranking
// quality. Set OPENAI_API_KEY to call OpenAI itself.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Query phrases -> words a choice should mention to satisfy that intent. */
const INTENTS: [string, string[]][] = [
  ["money back", ["refund", "return funds"]],
  ["charged twice", ["refund", "return funds"]],
];

interface Choice {
  value: string;
  description: string;
}

function judge(query: string, choices: Choice[]): { value: string; probability: number }[] {
  const wanted = INTENTS.filter(([phrase]) => query.toLowerCase().includes(phrase)).flatMap(
    ([, words]) => words,
  );
  const raw = choices.map((c) => ({
    value: c.value,
    probability: wanted.some((w) => c.description.toLowerCase().includes(w)) ? 0.9 : 0.01,
  }));
  const total = raw.reduce((a, b) => a + b.probability, 0) || 1;
  return raw.map((r) => ({ value: r.value, probability: r.probability / total }));
}

export interface LocalDecisions {
  url: string;
  requests: number;
  close: () => Promise<void>;
}

export async function startLocalDecisions(): Promise<LocalDecisions> {
  const state = { requests: 0 };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      state.requests += 1;
      const { input, questions } = JSON.parse(body) as {
        input: string;
        questions: { name: string; choices: Choice[] }[];
      };
      const [question] = questions;
      const probabilities = judge(input, question.choices);
      const best = probabilities.reduce((a, b) => (b.probability > a.probability ? b : a));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          answers: [
            {
              type: "choice",
              name: question.name,
              choice: best.value,
              probabilities,
              confidence: best.probability,
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get requests() {
      return state.requests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
