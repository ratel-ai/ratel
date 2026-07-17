import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// A handful of stub Mastra tools (native `createTool` shape). They register into
// Ratel's shared catalog through the adapter and stay hidden behind the three
// capability tools until the model searches for them.
export const tools = {
  read_file: createTool({
    id: "read_file",
    description: "Read a file from local disk and return its textual contents.",
    inputSchema: z.object({ path: z.string().describe("absolute path to the file") }),
    execute: async ({ path }) => ({ contents: `(stub) contents of ${path}` }),
  }),
  write_file: createTool({
    id: "write_file",
    description: "Write textual contents to a file on local disk.",
    inputSchema: z.object({
      path: z.string().describe("absolute path to the file"),
      contents: z.string().describe("bytes to write"),
    }),
    execute: async ({ path }) => ({ ok: true, path }),
  }),
  search_files: createTool({
    id: "search_files",
    description: "Grep across files in a directory using a regular expression.",
    inputSchema: z.object({
      root: z.string().describe("directory to scan recursively"),
      pattern: z.string().describe("regular expression to match"),
    }),
    execute: async ({ root, pattern }) => ({ matches: [{ path: `${root}/example.ts`, line: 42, match: pattern }] }),
  }),
  run_command: createTool({
    id: "run_command",
    description: "Execute a shell command and capture stdout, stderr, and exit code.",
    inputSchema: z.object({ command: z.string().describe("command line to run") }),
    execute: async ({ command }) => ({ stdout: `(stub) ran ${command}`, stderr: "", exitCode: 0 }),
  }),
  send_email: createTool({
    id: "send_email",
    description: "Send an email to a recipient via SMTP.",
    inputSchema: z.object({
      to: z.string().describe("recipient email address"),
      subject: z.string(),
      body: z.string(),
    }),
    execute: async ({ to }) => ({ messageId: "msg-stub", to }),
  }),
  query_database: createTool({
    id: "query_database",
    description: "Run a SQL query against the application database.",
    inputSchema: z.object({ sql: z.string().describe("SQL statement to execute") }),
    execute: async ({ sql }) => ({ rows: [], sql }),
  }),
};
