import { type ExecutableTool, ToolCatalog } from "@ratel-ai/sdk";
import { jsonSchema, tool } from "ai";

export const tools: ExecutableTool[] = [
  {
    id: "read_file",
    name: "read_file",
    description: "Read a file from local disk and return its textual contents.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "absolute path to the file" },
      },
      required: ["path"],
    },
    outputSchema: {
      type: "object",
      properties: { contents: { type: "string" } },
    },
    execute: async ({ path }) => ({ contents: `(stub) contents of ${path}` }),
  },
  {
    id: "write_file",
    name: "write_file",
    description: "Write textual contents to a file on local disk.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "absolute path to the file" },
        contents: { type: "string", description: "bytes to write" },
      },
      required: ["path", "contents"],
    },
    outputSchema: { type: "object" },
    execute: async ({ path }) => ({ ok: true, path }),
  },
  {
    id: "search_files",
    name: "search_files",
    description: "Grep across files in a directory using a regular expression.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "directory to scan recursively" },
        pattern: { type: "string", description: "regular expression to match" },
      },
      required: ["root", "pattern"],
    },
    outputSchema: {
      type: "object",
      properties: {
        matches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              line: { type: "number" },
            },
          },
        },
      },
    },
    execute: async ({ root, pattern }) => ({
      matches: [{ path: `${root}/example.ts`, line: 42, match: pattern }],
    }),
  },
  {
    id: "run_command",
    name: "run_command",
    description: "Execute a shell command and capture stdout, stderr, and exit code.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "command line to run" },
      },
      required: ["command"],
    },
    outputSchema: { type: "object" },
    execute: async ({ command }) => ({
      stdout: `(stub) ran ${command}`,
      stderr: "",
      exitCode: 0,
    }),
  },
  {
    id: "send_email",
    name: "send_email",
    description: "Send an email to a recipient via SMTP.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "recipient email address" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
    outputSchema: { type: "object" },
    execute: async ({ to }) => ({ messageId: `msg-${Date.now()}`, to }),
  },
  {
    id: "query_database",
    name: "query_database",
    description: "Run a SQL query against the application database.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL statement to execute" },
      },
      required: ["sql"],
    },
    outputSchema: { type: "object" },
    execute: async ({ sql }) => ({ rows: [], sql }),
  },
];

export async function buildCatalog(): Promise<ToolCatalog> {
  const catalog = new ToolCatalog();
  await catalog.register(tools);
  return catalog;
}

export function toAISDKTool(executable: ExecutableTool) {
  return tool({
    description: executable.description,
    inputSchema: jsonSchema(executable.inputSchema),
    execute: executable.execute,
  });
}
