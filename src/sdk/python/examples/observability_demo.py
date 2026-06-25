"""Ratel observability demo — drives the lean SDK end-to-end against the cloud.

Two things, both through the public SDK (no database access, no SQL):

  1. **Skill / tool suggestion** — for a few sample chat messages, rank the skill
     corpus and the tool catalog with Ratel's BM25 engine and show what context
     Ratel would surface (the "context engineering" pitch).
  2. **A realistic adoption story** — backfill N days of interactions where Ratel
     starts OFF (full tool catalog in every prompt, only "could-have-saved"
     recorded) and switches ON partway (prompts shrink, real savings recorded).
     Each interaction is shipped as one usage rollup to `POST /api/v1/events`, so
     the dashboard fills with real, SDK-sourced data.

Usage:

    export RATEL_API_KEY=rtl_...                 # the project's ingest key
    export RATEL_HOST=https://cloud.ratel.sh     # default
    python observability_demo.py --days 21 --runs 12 --adopt 0.55

Add `--suggest-only` to just print suggestions without sending anything.
"""

from __future__ import annotations

import argparse
import os
import random
import sys
from datetime import datetime, timedelta, timezone

from ratel_ai import (
    ExecutableTool,
    Skill,
    SkillCatalog,
    ToolCatalog,
    _native,
    get_client,
)

MODELS = ("claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5")

# A representative "customer stack": enough tools that selection matters.
_TOOLS: list[tuple[str, str]] = [
    ("read_file", "Read a file from local disk and return its textual contents."),
    ("write_file", "Write or overwrite a file on local disk with the given contents."),
    ("list_dir", "List the entries (files and folders) of a directory on local disk."),
    ("search_code", "Full-text and symbol search across the repository's source files."),
    ("run_shell", "Execute a shell command in the project sandbox and capture stdout/stderr."),
    ("git_commit", "Stage changes and create a git commit with a message on the current branch."),
    ("git_diff", "Show the working-tree or staged diff against a base branch."),
    ("open_pull_request", "Open a GitHub pull request from the current branch with a title and body."),
    ("send_email", "Send an email message to one or more recipients with a subject and body."),
    ("schedule_event", "Create a calendar event with attendees, a time range, and a location."),
    ("query_database", "Run a parameterized read-only SQL query against the analytics warehouse."),
    ("insert_record", "Insert a row into a relational database table with validated columns."),
    ("http_get", "Perform an HTTP GET request to a URL and return the response body and status."),
    ("http_post", "Perform an HTTP POST request with a JSON body and return the response."),
    ("web_search", "Search the public web for a query and return ranked result snippets."),
    ("fetch_url", "Fetch and clean the readable text content of a web page by URL."),
    ("translate_text", "Translate a passage of text from a source language to a target language."),
    ("summarize_text", "Produce a concise summary of a long passage of text."),
    ("transcribe_audio", "Transcribe spoken audio into text with speaker labels and timestamps."),
    ("generate_image", "Generate an image from a text prompt and return its URL."),
    ("create_chart", "Render a chart (line, bar, area) from a series of data points to an image."),
    ("send_slack", "Post a message to a Slack channel or direct message."),
    ("create_ticket", "Create an issue ticket in the project tracker with labels and an assignee."),
    ("charge_card", "Charge a saved payment method for an amount in a given currency."),
    ("geocode_address", "Resolve a street address to latitude/longitude coordinates."),
    ("weather_forecast", "Return the multi-day weather forecast for a set of coordinates."),
]

# On-demand skills — reusable playbooks Ratel surfaces when the intent matches.
_SKILLS: list[tuple[str, str, list[str], list[str]]] = [
    ("frontend-forms", "Build accessible web forms with client and server validation and error states.",
     ["frontend", "forms", "login", "validation", "react"], ["write_file", "search_code"]),
    ("api-design", "Design REST APIs: resource naming, status codes, pagination, idempotency.",
     ["backend", "api", "rest", "endpoints"], ["query_database", "http_post"]),
    ("data-pipeline", "Build batch and streaming data pipelines with backfills and idempotent writes.",
     ["data", "etl", "pipeline", "warehouse", "sql"], ["query_database", "insert_record"]),
    ("debugging", "Systematic debugging: reproduce, bisect, instrument, and isolate root cause.",
     ["debug", "bug", "crash", "stack trace", "investigate"], ["search_code", "run_shell"]),
    ("security-review", "Review code for injection, auth, secrets, and OWASP Top 10 issues.",
     ["security", "auth", "vulnerability", "owasp", "secrets"], ["search_code", "git_diff"]),
    ("testing", "Write unit, integration, and e2e tests and raise coverage methodically.",
     ["test", "tdd", "coverage", "pytest", "e2e"], ["write_file", "run_shell"]),
    ("release", "Cut a versioned release: changelog, tags, and a coordinated rollout.",
     ["release", "version", "changelog", "deploy", "rollout"], ["git_commit", "open_pull_request"]),
    ("slides", "Build animation-rich HTML presentations and decks from an outline.",
     ["frontend", "presentation", "slides", "deck"], ["generate_image", "create_chart"]),
]

# Sample user turns the demo ranks against — varied intent.
_MESSAGES = [
    "build me a login form with email and password validation",
    "design a REST endpoint for paginated orders",
    "the worker crashes with a KeyError on startup, help me debug it",
    "review this auth middleware for security holes",
    "write integration tests for the billing service",
    "set up a nightly ETL job from postgres into the warehouse",
    "cut the v2 release with a changelog and tag",
    "make an animated slide deck from these notes",
    "summarize this thread and email it to the team",
    "what's the weather forecast for our offsite location",
]


def _rich_input_schema(tool_id: str, description: str) -> dict:
    """A realistically-sized JSON schema — real tool/MCP catalogs carry detailed
    parameter definitions, which is exactly the context selection prunes."""
    return {
        "type": "object",
        "description": description,
        "properties": {
            "query": {
                "type": "string",
                "description": f"Primary input for {tool_id}: the natural-language request or target identifier.",
            },
            "options": {
                "type": "object",
                "description": "Optional settings controlling retries, formatting, and side effects.",
                "properties": {
                    "timeout_ms": {"type": "integer", "description": "Abort the call after this many milliseconds."},
                    "dry_run": {"type": "boolean", "description": "Validate inputs without performing any side effects."},
                    "format": {"type": "string", "enum": ["json", "text", "markdown"], "description": "Desired response format."},
                    "max_results": {"type": "integer", "description": "Upper bound on the number of returned items."},
                },
            },
            "metadata": {
                "type": "object",
                "description": "Caller-supplied tags propagated to traces and audit logs for this invocation.",
            },
        },
        "required": ["query"],
    }


def _output_schema(tool_id: str) -> dict:
    return {
        "type": "object",
        "description": f"Structured result returned by {tool_id}.",
        "properties": {
            "ok": {"type": "boolean", "description": "Whether the call succeeded."},
            "data": {"type": "object", "description": "The tool's result payload, shape depends on the tool."},
            "error": {"type": "string", "description": "Human-readable error message when ok is false."},
        },
    }


def _build_tool_catalog() -> ToolCatalog:
    catalog = ToolCatalog(observe=True)
    for tool_id, description in _TOOLS:
        catalog.register(
            ExecutableTool(
                id=tool_id,
                name=tool_id,
                description=description,
                input_schema=_rich_input_schema(tool_id, description),
                output_schema=_output_schema(tool_id),
                execute=lambda args: {},
            )
        )
    return catalog


def _build_skill_catalog() -> SkillCatalog:
    catalog = SkillCatalog()
    for skill_id, description, tags, tools in _SKILLS:
        catalog.register(
            Skill(
                id=skill_id,
                name=skill_id,
                description=description,
                tags=tags,
                tools=tools,
                body=f"# {skill_id}\n\n{description}\n\nStep-by-step playbook ...",
            )
        )
    return catalog


def print_suggestions(tools: ToolCatalog, skills: SkillCatalog) -> None:
    print("\n▸ Skill + tool suggestions (Ratel BM25 over the corpus)\n")
    for message in _MESSAGES[:5]:
        print(f'  "{message}"')
        skill_hits = skills.search(message, top_k=2)
        for hit in skill_hits:
            meta = next((s for s in _SKILLS if s[0] == hit.skill_id), None)
            pulls = f"   pulls in: {', '.join(meta[3])}" if meta else ""
            print(f"     → skill  {hit.skill_id:<16} ({hit.score:4.1f}){pulls}")
        tool_hits = tools.search(message, top_k=3)
        kept = ", ".join(h.tool_id for h in tool_hits)
        if tools.last_savings:
            saved = tools.last_savings["tokens_saved"]
            print(f"     → tools  {kept}   (saved ~{saved:,} ctx tokens)")
        print()


def _bar(value: int, lo: int, hi: int, width: int = 18) -> str:
    span = max(1, hi - lo)
    filled = max(0, min(width, round((value - lo) / span * width)))
    return "█" * filled + "░" * (width - filled)


def seed_adoption_story(
    tools: ToolCatalog, skills: SkillCatalog, *, days: int, runs: int, adopt: float
) -> int:
    client = get_client()
    tools.search(_MESSAGES[0], top_k=6)
    full_catalog = int(tools.last_savings["full_catalog_tokens"]) if tools.last_savings else 0
    total = days * runs
    transition_day = int(days * adopt)
    print(
        f"\n▸ Seeding {total} interactions over {days} days "
        f"(Ratel switches on at day {transition_day + 1}/{days})\n"
    )
    sent = 0
    now = datetime.now(timezone.utc)
    for day in range(days):
        ratel_on = day >= transition_day
        day_spend = 0
        day_saved = 0
        for _run in range(runs):
            message = random.choice(_MESSAGES)
            tools.search(message, top_k=6)
            sv = tools.last_savings or {"full_catalog_tokens": full_catalog, "selected_tokens": 0}
            full = sv["full_catalog_tokens"]
            selected = sv["selected_tokens"]

            skill_hits = skills.search(message, top_k=2)
            skill_ids = [h.skill_id for h in skill_hits]
            skills_tok = sum(
                int(_native.estimate_tokens(next(s[1] for s in _SKILLS if s[0] == sid)))
                for sid in skill_ids
            ) + 40 * len(skill_ids)

            tools_tok = selected if ratel_on else full
            history = random.randint(800, 2200) + day * 90
            memory = random.randint(180, 360)
            user_input = int(_native.estimate_tokens(message))
            output_tokens = random.randint(120, 420)
            model = random.choice(MODELS)

            saved = None
            saveable = None
            if ratel_on:
                saved = {"tools": max(0, full - selected), "skills": random.randint(300, 700)}
            else:
                saveable = {"tools": max(0, full - selected), "skills": random.randint(280, 620)}

            input_total = skills_tok + tools_tok + history + memory + user_input
            # Latency scales with prompt size, so a leaner Ratel-on prompt is also
            # a faster one — a nice secondary story on the dashboard.
            latency_ms = round((2200 + input_total / 9.0) * (0.8 + random.random() * 0.4))
            occurred = now - timedelta(days=days - 1 - day, hours=random.uniform(0, 9))
            client.track(
                tokens_by_category={
                    "skills": skills_tok,
                    "tools": tools_tok,
                    "history": history,
                    "memory": memory,
                    "user_input": user_input,
                },
                saved_by_category=saved,
                saveable_by_category=saveable,
                input_tokens=input_total,
                output_tokens=output_tokens,
                model=model,
                latency_ms=latency_ms,
                occurred_at=occurred,
            )
            sent += 1
            day_spend += skills_tok + tools_tok + history + memory + user_input
            day_saved += (saved or saveable or {}).get("tools", 0)

        state = "on " if ratel_on else "off"
        avg_spend = day_spend // runs
        label = "saved " if ratel_on else "saveable"
        print(
            f"  day {day + 1:2d}/{days}  ratel:{state}  spend {avg_spend:6,} tok/run  "
            f"{label} ~{day_saved // runs:5,}  {_bar(avg_spend, 3000, 12000)}"
        )

    client.flush(timeout=15)
    return sent


def main() -> int:
    parser = argparse.ArgumentParser(description="Ratel observability demo / SDK seeder")
    parser.add_argument("--days", type=int, default=21)
    parser.add_argument("--runs", type=int, default=12, help="interactions per day")
    parser.add_argument("--adopt", type=float, default=0.55, help="fraction of the window before Ratel is on")
    parser.add_argument("--seed", type=int, default=7, help="PRNG seed for reproducibility")
    parser.add_argument("--suggest-only", action="store_true", help="print suggestions, send nothing")
    args = parser.parse_args()
    random.seed(args.seed)

    host = os.environ.get("RATEL_HOST", "https://cloud.ratel.sh")
    has_key = bool(os.environ.get("RATEL_API_KEY"))
    print("\U0001f405 Ratel · context engineering live demo")
    print(f"   cloud: {host}  →  POST /api/v1/events")
    if not has_key and not args.suggest_only:
        print("\n   ! RATEL_API_KEY is unset — running in no-op mode (nothing will be sent).")
        print("     export RATEL_API_KEY=rtl_... to populate the dashboard.\n")

    tools = _build_tool_catalog()
    skills = _build_skill_catalog()
    print(f"   stack: {len(_TOOLS)} tools, {len(_SKILLS)} skills registered")

    print_suggestions(tools, skills)
    if args.suggest_only:
        return 0

    sent = seed_adoption_story(tools, skills, days=args.days, runs=args.runs, adopt=args.adopt)
    print(f"\n✓ sent {sent} rollups · flushed — open the dashboard to see them land.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
