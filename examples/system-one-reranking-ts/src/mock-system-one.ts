// A local stand-in for Ratel Cloud's `POST /v1/systemone`, so the example runs
// with no API key. It speaks the real wire contract (ADR-0026):
//
//   request  { query, candidates: [{ id, text }], top_k }
//   response { ranked: [{ id, score }], provider, model }
//
// The "model" is a hard-coded intent table, not a system-one model: it exists to
// show the plumbing, not to rank well. Point RATEL_SYSTEM_ONE_URL at the real
// endpoint to use one.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

interface Candidate {
  id: string;
  text: string;
}

/** Query phrases → words a candidate should mention to satisfy that intent. */
const INTENTS: [string, string[]][] = [
  ["money back", ["refund", "return funds"]],
  ["charged twice", ["refund", "return funds"]],
  ["email", ["email"]],
];

function rank(query: string, candidates: Candidate[], topK: number) {
  const wanted = INTENTS.filter(([phrase]) => query.toLowerCase().includes(phrase)).flatMap(
    ([, words]) => words,
  );
  return candidates
    .map((c) => {
      const text = c.text.toLowerCase();
      const hits = wanted.filter((w) => text.includes(w)).length;
      return { id: c.id, score: hits === 0 ? 0.01 : Math.min(0.95, 0.5 + 0.2 * hits) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export interface MockSystemOne {
  url: string;
  requests: number;
  close: () => Promise<void>;
}

export async function startMockSystemOne(): Promise<MockSystemOne> {
  const state = { requests: 0 };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      state.requests += 1;
      const { query, candidates, top_k } = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ranked: rank(query, candidates, top_k),
          provider: "local-mock",
          model: "intent-table",
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    get requests() {
      return state.requests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
