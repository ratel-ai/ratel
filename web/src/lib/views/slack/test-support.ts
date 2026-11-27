import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  path: string;
  authorization: string;
  params: Record<string, string>;
}

/** A local server in Slack's place: what it got, and what it answers next. */
export async function fakeSlack() {
  const fake = {
    url: "",
    received: [] as FakeRequest[],
    answer: (_request: FakeRequest, _response: ServerResponse): void => {},
    /** The answer of every next call, as JSON: Slack answers 200 on failure too. */
    json(body: unknown) {
      fake.answer = (_, response) => {
        response.end(JSON.stringify(body));
      };
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const got = {
        path: request.url ?? "",
        authorization: request.headers.authorization ?? "",
        params: Object.fromEntries(new URLSearchParams(body)),
      };
      fake.received.push(got);
      fake.answer(got, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
