// A local stand-in for Jev's `POST /v1/systemone`, so the example runs with no
// TypeSafe key. It speaks Jev's wire format:
//
//   request  { model, state, questions: { tool: { type: "choice", criteria: { t0: "…", … } } } }
//
// (The question id is the kind being ranked: "tool" here, "skill" for skills.)
//   response { model, answers: { tool: { type: "choice", probabilities: { t0: 0.9, … } } } }
//
// Its "judge" is a hard-coded intent table: it shows the plumbing, not ranking
// quality. Set TYPESAFE_API_KEY to call Jev itself.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Query phrases -> words an option should mention to satisfy that intent. */
const INTENTS: [string, string[]][] = [
  ["money back", ["refund", "return funds"]],
  ["charged twice", ["refund", "return funds"]],
];

function judge(query: string, criteria: Record<string, string>): Record<string, number> {
  const wanted = INTENTS.filter(([phrase]) => query.toLowerCase().includes(phrase)).flatMap(
    ([, words]) => words,
  );
  const raw = Object.fromEntries(
    Object.entries(criteria).map(([key, text]) => [
      key,
      wanted.some((w) => text.toLowerCase().includes(w)) ? 0.9 : 0.01,
    ]),
  );
  const total = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v / total]));
}

export interface LocalJev {
  url: string;
  requests: number;
  close: () => Promise<void>;
}

export async function startLocalJev(): Promise<LocalJev> {
  const state = { requests: 0 };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      state.requests += 1;
      const { model, state: query, questions } = JSON.parse(body);
      const [kind, question] = Object.entries(questions)[0] as [
        string,
        { criteria: Record<string, string> },
      ];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model,
          answers: {
            [kind]: { type: "choice", probabilities: judge(query, question.criteria) },
          },
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
