import { jsonSchema, tool } from "ai";

// A demo catalog of AI SDK-native tools — defined with `tool()` exactly as any
// AI SDK app would, no Ratel-specific shapes. The adapter view ingests these
// as-is (`view.tools.register(tools)`); stub executors stand in for real ones.
export const tools = {
  read_file: tool({
    description: "Read a file from local disk and return its textual contents.",
    inputSchema: jsonSchema<{ path: string }>({
      type: "object",
      properties: {
        path: { type: "string", description: "absolute path to the file" },
      },
      required: ["path"],
    }),
    execute: async ({ path }) => ({ contents: `(stub) contents of ${path}` }),
  }),
  write_file: tool({
    description: "Write textual contents to a file on local disk.",
    inputSchema: jsonSchema<{ path: string; contents: string }>({
      type: "object",
      properties: {
        path: { type: "string", description: "absolute path to the file" },
        contents: { type: "string", description: "bytes to write" },
      },
      required: ["path", "contents"],
    }),
    execute: async ({ path }) => ({ ok: true, path }),
  }),
  search_files: tool({
    description: "Grep across files in a directory using a regular expression.",
    inputSchema: jsonSchema<{ root: string; pattern: string }>({
      type: "object",
      properties: {
        root: { type: "string", description: "directory to scan recursively" },
        pattern: { type: "string", description: "regular expression to match" },
      },
      required: ["root", "pattern"],
    }),
    execute: async ({ root, pattern }) => ({
      matches: [{ path: `${root}/example.ts`, line: 42, match: pattern }],
    }),
  }),
  run_command: tool({
    description: "Execute a shell command and capture stdout, stderr, and exit code.",
    inputSchema: jsonSchema<{ command: string }>({
      type: "object",
      properties: {
        command: { type: "string", description: "command line to run" },
      },
      required: ["command"],
    }),
    execute: async ({ command }) => ({
      stdout: `(stub) ran ${command}`,
      stderr: "",
      exitCode: 0,
    }),
  }),
  send_email: tool({
    description: "Send an email to a recipient via SMTP.",
    inputSchema: jsonSchema<{ to: string; subject: string; body: string }>({
      type: "object",
      properties: {
        to: { type: "string", description: "recipient email address" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    }),
    execute: async ({ to }) => ({ messageId: `msg-${Date.now()}`, to }),
  }),
  query_database: tool({
    description: "Run a SQL query against the application database.",
    inputSchema: jsonSchema<{ sql: string }>({
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL statement to execute" },
      },
      required: ["sql"],
    }),
    execute: async ({ sql }) => ({ rows: [], sql }),
  }),
};
