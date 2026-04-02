/**
 * Dummy MCP server exposing a small "knowledge base" toolkit.
 *
 * Tools:
 *   - lookup_employee   — look up an employee by name
 *   - list_departments  — list all departments
 *   - get_headcount     — return headcount for a department
 *
 * Runs on Streamable HTTP so the SDK's mcpTools() can connect directly.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Fake data ────────────────────────────────────────────────────────────

const employees: Record<string, { role: string; department: string; started: string }> = {
  alice: { role: "Engineering Manager", department: "Engineering", started: "2019-03-15" },
  bob: { role: "Product Designer", department: "Design", started: "2021-06-01" },
  carol: { role: "Data Scientist", department: "Engineering", started: "2022-01-10" },
  dave: { role: "Recruiter", department: "People", started: "2023-08-22" },
};

const departments: Record<string, number> = {
  Engineering: 42,
  Design: 8,
  People: 5,
  Marketing: 12,
};

// ── MCP server ───────────────────────────────────────────────────────────

function createMcpServer(): Server {
  const server = new Server(
    { name: "hr-knowledge-base", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "lookup_employee",
        description:
          "Look up an employee by first name and return their role, department, and start date.",
        inputSchema: {
          type: "object" as const,
          properties: {
            name: { type: "string", description: "Employee first name (case-insensitive)" },
          },
          required: ["name"],
        },
      },
      {
        name: "list_departments",
        description: "List all departments in the company.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "get_headcount",
        description: "Return the headcount for a given department.",
        inputSchema: {
          type: "object" as const,
          properties: {
            department: { type: "string", description: "Department name" },
          },
          required: ["department"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params;

    if (name === "lookup_employee") {
      const key = String(args.name).toLowerCase();
      const emp = employees[key];
      if (!emp) {
        return { content: [{ type: "text", text: `No employee found with name "${args.name}".` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ name: args.name, ...emp }, null, 2),
          },
        ],
      };
    }

    if (name === "list_departments") {
      return {
        content: [{ type: "text", text: JSON.stringify(Object.keys(departments)) }],
      };
    }

    if (name === "get_headcount") {
      const dept = String(args.department);
      const count = departments[dept];
      if (count === undefined) {
        return { content: [{ type: "text", text: `Unknown department "${dept}".` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ department: dept, headcount: count }) }],
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}

// ── HTTP transport ───────────────────────────────────────────────────────

let sessionTransport: StreamableHTTPServerTransport | null = null;

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (
    req.url === "/mcp" &&
    (req.method === "POST" || req.method === "GET" || req.method === "DELETE")
  ) {
    const body = await readBody(req);
    if (!sessionTransport) {
      sessionTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => "session",
      });
      const server = createMcpServer();
      await server.connect(sessionTransport);
    }
    await sessionTransport.handleRequest(req, res, body);
  } else {
    res.writeHead(404);
    res.end();
  }
});

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

// ── Start ────────────────────────────────────────────────────────────────

const PORT = Number(process.env.MCP_PORT ?? 3099);

export function startMcpServer(): Promise<typeof httpServer> {
  return new Promise((resolve) => {
    httpServer.listen(PORT, () => {
      console.log(`[mcp-server] HR Knowledge Base running on http://localhost:${PORT}/mcp`);
      resolve(httpServer);
    });
  });
}

export const MCP_URL = `http://localhost:${PORT}/mcp`;

// Allow running standalone: node mcp-server.ts
if (process.argv[1]?.endsWith("mcp-server.ts")) {
  startMcpServer();
}
