import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import type {
  ToolDef,
  SetupBody,
  SendMessageBody,
  SendMessageResponse,
} from "../../lib/protocol.js";

export interface ExecutableTool extends ToolDef {
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentCallbacks {
  port?: number;
  setup: (tools: ExecutableTool[], config: SetupBody["config"]) => Promise<void>;
  sendMessage: (body: SendMessageBody) => Promise<SendMessageResponse>;
}

export function executeTool(
  script: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile("bash", [script], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Tool script failed: ${stderr || err.message}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Invalid JSON from tool script: ${stdout.slice(0, 200)}`));
      }
    });
    child.stdin!.write(JSON.stringify(args));
    child.stdin!.end();
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function startAgent(callbacks: AgentCallbacks): Promise<{ close: () => Promise<void> }> {
  const port = callbacks.port ?? Number(process.env.AGENT_PORT) ?? 9300;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && req.url === "/setup") {
        const body: SetupBody = JSON.parse(await readBody(req));
        const tools: ExecutableTool[] = body.tools.map((t) => ({
          ...t,
          execute: (args: Record<string, unknown>) => executeTool(t.script, args),
        }));
        await callbacks.setup(tools, body.config);
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && req.url === "/send-message") {
        const body: SendMessageBody = JSON.parse(await readBody(req));
        const result = await callbacks.sendMessage(body);
        return json(res, 200, result);
      }

      json(res, 404, { error: "Not found" });
    } catch (e: any) {
      json(res, 500, { error: e.message });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
