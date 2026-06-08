"""A demo tool catalog — the Python mirror of `examples/ai-sdk/src/tools.ts`.

Six stub tools with realistic descriptions and JSON schemas, registered into a
`ToolCatalog`. Ratel ranks them by BM25 so only the relevant few reach the model.
"""

from __future__ import annotations

from typing import Any

from ratel_ai import ExecutableTool, ToolCatalog

TOOLS: list[ExecutableTool] = [
    ExecutableTool(
        id="read_file",
        name="read_file",
        description="Read a file from local disk and return its textual contents.",
        input_schema={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "absolute path to the file"},
            },
            "required": ["path"],
        },
        output_schema={"type": "object", "properties": {"contents": {"type": "string"}}},
        execute=lambda args: {"contents": f"(stub) contents of {args['path']}"},
    ),
    ExecutableTool(
        id="write_file",
        name="write_file",
        description="Write textual contents to a file on local disk.",
        input_schema={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "absolute path to the file"},
                "contents": {"type": "string", "description": "bytes to write"},
            },
            "required": ["path", "contents"],
        },
        output_schema={"type": "object"},
        execute=lambda args: {"ok": True, "path": args["path"]},
    ),
    ExecutableTool(
        id="search_files",
        name="search_files",
        description="Grep across files in a directory using a regular expression.",
        input_schema={
            "type": "object",
            "properties": {
                "root": {"type": "string", "description": "directory to scan recursively"},
                "pattern": {"type": "string", "description": "regular expression to match"},
            },
            "required": ["root", "pattern"],
        },
        output_schema={"type": "object"},
        execute=lambda args: {
            "matches": [{"path": f"{args['root']}/example.py", "line": 42}]
        },
    ),
    ExecutableTool(
        id="run_command",
        name="run_command",
        description="Execute a shell command and capture stdout, stderr, and exit code.",
        input_schema={
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "command line to run"},
            },
            "required": ["command"],
        },
        output_schema={"type": "object"},
        execute=lambda args: {"stdout": f"(stub) ran {args['command']}", "stderr": "", "exitCode": 0},
    ),
    ExecutableTool(
        id="send_email",
        name="send_email",
        description="Send an email to a recipient via SMTP.",
        input_schema={
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "recipient email address"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["to", "subject", "body"],
        },
        output_schema={"type": "object"},
        execute=lambda args: {"messageId": "msg-stub", "to": args["to"]},
    ),
    ExecutableTool(
        id="query_database",
        name="query_database",
        description="Run a SQL query against the application database.",
        input_schema={
            "type": "object",
            "properties": {
                "sql": {"type": "string", "description": "SQL statement to execute"},
            },
            "required": ["sql"],
        },
        output_schema={"type": "object"},
        execute=lambda args: {"rows": [], "sql": args["sql"]},
    ),
]


def build_catalog() -> ToolCatalog:
    catalog = ToolCatalog()
    for tool in TOOLS:
        catalog.register(tool)
    return catalog


def tool_result_to_text(result: Any) -> str:
    return str(result)
