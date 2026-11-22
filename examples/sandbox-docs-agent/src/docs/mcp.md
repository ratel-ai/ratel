# Connect an agent over MCP

Ratel has an MCP server, so an agent can query it. Connect to `POST <BASE_URL>/api/mcp` with `Authorization: Bearer <project key>`.

For Claude Code:

```sh
claude mcp add --transport http ratel <BASE_URL>/api/mcp --header "Authorization: Bearer $RATEL_API_KEY"
```

The console's **Integrations** page has setup for Claude Code, Claude Desktop, Cursor and VS Code.
