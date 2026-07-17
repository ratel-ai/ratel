import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

/** Test-only helper (not part of the published package); shared by the tool-
 * and skill-catalog test suites. */
export interface DelayedEmbeddingServer {
  url: string;
  requests: string[][];
  close: () => Promise<void>;
}

/** An OpenAI-compatible embedding endpoint that sleeps briefly per request, run
 * in a child process (real wall-clock delay) — shared by tool- and
 * skill-catalog tests that assert dense registration/search doesn't block
 * Node's event loop. */
export async function startDelayedEmbeddingServer(delayMs = 120): Promise<DelayedEmbeddingServer> {
  const source = `
    const http = require("node:http");
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body);
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
        process.stdout.write(JSON.stringify(inputs) + "\\n");
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            model: payload.model,
            data: inputs.map((_, index) => ({ index, embedding: [index + 1, 1] })),
          }));
        }, ${delayMs});
      });
    });
    server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `;
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const [line] = (await Promise.race([
    once(lines, "line"),
    once(child, "exit").then(([code]) => {
      throw new Error(`embedding test server exited during startup (${String(code)})`);
    }),
    new Promise<never>((_, reject) => {
      startupTimer = setTimeout(
        () => reject(new Error("embedding test server startup timed out")),
        5_000,
      );
    }),
  ]).finally(() => clearTimeout(startupTimer))) as [string];
  const requests: string[][] = [];
  lines.on("line", (requestLine) => requests.push(JSON.parse(requestLine) as string[]));
  return {
    url: `http://127.0.0.1:${Number(line)}/v1/embeddings`,
    requests,
    close: async () => {
      lines.close();
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    },
  };
}
