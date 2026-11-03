/**
 * Copy-paste MCP client configuration, built per project.
 *
 * Pure string builders with their own tests, exactly like `lib/quickstart.ts`:
 * the value of this page is that the snippet already contains the reader's own
 * endpoint, so a wrong string here is a support ticket rather than a typo.
 *
 * Every client sends a project API key. This edition has no browser sign-in,
 * so the OAuth path upstream offers its interactive clients does not exist
 * here: a client that connected without a key would get a 401 and nowhere to
 * go. Where upstream's snippet differs from the one below, the difference is
 * exactly the key.
 */
export const MCP_CLIENTS = ["claude-code", "claude-desktop", "cursor", "cli"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export const MCP_CLIENT_LABELS: Record<McpClient, string> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor / VS Code",
  cli: "CI / headless",
};

/**
 * The env var the snippets reference. The key itself is never rendered unless
 * it was minted on this page view: a plaintext key is shown exactly once, at
 * creation, and re-displaying it here would quietly undo that.
 */
export const MCP_KEY_ENV = "RATEL_API_KEY";

/** The connection name a user will see in their client's server list. */
const SERVER_NAME = "ratel";

/**
 * What stands in for the key when we do not have one to show.
 *
 * We usually do not. Keys are stored as a SHA-256 hash plus a display prefix,
 * so an existing key's plaintext is unrecoverable by design: the only moment it
 * can appear in a snippet is the request that created it.
 */
export const MCP_KEY_PLACEHOLDER = "rtl_your_key_here";

export interface McpSnippetTarget {
  endpoint: string;
  /** A freshly minted key, shown once. Omitted leaves the placeholder. */
  apiKey?: string | null;
}

export interface McpSnippet {
  client: McpClient;
  /** Optional one-line orientation shown above the block. */
  note: string | null;
  code: string;
  /**
   * How this client proves who it is.
   *
   * `key` is the only value this edition produces: every client carries a
   * project key. `oauth` stays in the type for the connect component, which
   * draws a different panel for a client that signs in through a browser.
   */
  auth: "oauth" | "key";
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

const authHeader = `Authorization: Bearer $${MCP_KEY_ENV}`;

/** The shell line that puts the key where the snippet below reads it from. */
function exportKey({ apiKey }: McpSnippetTarget): string {
  return `export ${MCP_KEY_ENV}=${apiKey ?? MCP_KEY_PLACEHOLDER}`;
}

/**
 * Claude Code speaks Streamable HTTP natively and takes the header on the
 * command line, so no bridge is needed; the key is read from the shell.
 */
function claudeCode(target: McpSnippetTarget): McpSnippet {
  return {
    client: "claude-code",
    note: "Run this once in the shell that will start Claude Code. The key is read from the environment, not stored by the command.",
    auth: "key",
    code: [
      exportKey(target),
      `claude mcp add --transport http ${SERVER_NAME} ${target.endpoint} \\`,
      `  --header ${quoted(authHeader)}`,
    ].join("\n"),
  };
}

/**
 * Claude Desktop's custom connectors take a bare URL and expect to sign in, so
 * a key has to travel through the `mcp-remote` bridge in the desktop config.
 * The bridge expands `${RATEL_API_KEY}` from its `env` block.
 */
function claudeDesktop({ endpoint, apiKey }: McpSnippetTarget): McpSnippet {
  return {
    client: "claude-desktop",
    note: "Settings -> Developer -> Edit Config, then add this under mcpServers. The file holds the key: keep it private.",
    auth: "key",
    code: JSON.stringify(
      {
        mcpServers: {
          [SERVER_NAME]: {
            command: "npx",
            args: [
              "-y",
              "mcp-remote",
              endpoint,
              "--header",
              `Authorization: Bearer \${${MCP_KEY_ENV}}`,
            ],
            env: { [MCP_KEY_ENV]: apiKey ?? MCP_KEY_PLACEHOLDER },
          },
        },
      },
      null,
      2,
    ),
  };
}

/**
 * The editor config is commonly committed, so the key never goes in the file:
 * both editors expand `${env:NAME}` from the environment the editor started in.
 */
function cursor({ endpoint }: McpSnippetTarget): McpSnippet {
  return {
    client: "cursor",
    note: `Add to .cursor/mcp.json, or .vscode/mcp.json for VS Code, with ${MCP_KEY_ENV} set in the environment the editor starts from.`,
    auth: "key",
    code: JSON.stringify(
      {
        mcpServers: {
          [SERVER_NAME]: {
            url: endpoint,
            headers: { Authorization: `Bearer \${env:${MCP_KEY_ENV}}` },
          },
        },
      },
      null,
      2,
    ),
  };
}

/**
 * CI has no browser to send anyone to, so a project key is the right
 * credential there: narrow by construction, and revocable without touching a
 * person's account.
 */
function cli(target: McpSnippetTarget): McpSnippet {
  return {
    client: "cli",
    note: "For CI and headless runs.",
    auth: "key",
    code: [
      exportKey(target),
      `npx -y mcp-remote ${target.endpoint} \\`,
      `  --header ${quoted(authHeader)}`,
    ].join("\n"),
  };
}

const BUILDERS: Record<McpClient, (target: McpSnippetTarget) => McpSnippet> = {
  "claude-code": claudeCode,
  "claude-desktop": claudeDesktop,
  cursor,
  cli,
};

export function buildMcpSnippet(client: McpClient, target: McpSnippetTarget): McpSnippet {
  return BUILDERS[client](target);
}

export function buildMcpSnippetSet(target: McpSnippetTarget): Record<McpClient, McpSnippet> {
  return Object.fromEntries(
    MCP_CLIENTS.map((client) => [client, buildMcpSnippet(client, target)]),
  ) as Record<McpClient, McpSnippet>;
}

/**
 * The worked example, as data rather than a pre-formatted blob.
 *
 * It was a `CodeBlock` at first, which was a mistake: a copy button on
 * illustrative output invites someone to paste a transcript into a terminal.
 * Structured here so the page can render it as what it is, a short record of
 * two tool calls and what came back.
 */
export interface McpExampleStep {
  tool: string;
  /** Arguments worth showing, already formatted for display. */
  args?: string;
  /** Column headings for the returned rows, when it returns a table. */
  columns?: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
}

export const MCP_EXAMPLE_QUESTION = "Which of my skills never actually get used?";

export const MCP_EXAMPLE_STEPS: readonly McpExampleStep[] = [
  {
    tool: "get_improvement_signals",
    columns: ["skill", "retrieved", "invoked"],
    rows: [
      ["refund-policy", "214", "0"],
      ["shipping-estimate", "86", "0"],
    ],
  },
  {
    tool: "list_search_queries_for_skill",
    args: 'skillName: "refund-policy"',
    rows: [["how do I get my money back"], ["cancel my order"], ["track my package"]],
  },
];

/** The takeaway the example is built to produce. */
export const MCP_EXAMPLE_CONCLUSION =
  "Its description matches billing questions, not returns. That is why it is retrieved and never used.";

/**
 * The capability groups shown on the page, mirroring the registry domains.
 *
 * Each carries a couple of real tool names so a reader can match what they see
 * here against what their client's tool picker lists.
 */
export const MCP_CAPABILITY_GROUPS: ReadonlyArray<{
  title: string;
  blurb: string;
  examples: readonly string[];
}> = [
  {
    title: "Orientation",
    blurb: "Where you are and what is here",
    examples: ["get_project_overview", "list_projects"],
  },
  {
    title: "Catalog",
    blurb: "Skills and tools, declared and observed",
    examples: ["list_skills", "get_catalog_status", "list_declared_tools"],
  },
  {
    title: "Observability",
    blurb: "Traces, cost, and where retrieval disagreed",
    examples: ["get_trace_health", "get_cost_by_day", "list_calibration_mismatches"],
  },
  {
    title: "Improvement",
    blurb: "Match quality runs and the rewrites they propose",
    examples: ["list_match_quality_runs", "get_match_quality_run"],
  },
  {
    title: "Answers",
    blurb: "Joins across catalog and telemetry, and what-if runs",
    examples: ["get_improvement_signals", "test_retrieval"],
  },
  {
    title: "Status",
    blurb: "What is enabled, plan limits, queued jobs",
    examples: ["get_flag_status", "get_quota_status", "get_job_status"],
  },
  {
    title: "Changes",
    blurb: "Edit the catalog, publish, import in bulk",
    examples: ["update_skill", "publish_skill", "import_skills"],
  },
];
