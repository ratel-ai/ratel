<div align="center">
  <h1>Ratel</h1>
  <p>See what your AI agent gets wrong, and what to change. On your own infrastructure.</p>

  <p>
    <a href="https://docs.ratel.sh">Docs</a> •
    <a href="https://github.com/ratel-ai/skills">Skills</a> •
    <a href="https://discord.gg/75vAPdjYqT">Discord</a>
  </p>

  <p>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="https://discord.gg/75vAPdjYqT"><img src="https://img.shields.io/discord/1478702964003705015?label=Discord&logo=discord&logoColor=white&color=5865F2" alt="Discord" /></a>
    <a href="#license"><img src="https://img.shields.io/badge/license-Apache--2.0%20%26%20MIT-blue" alt="license" /></a>
  </p>
</div>

## Introduction

Ratel is a self-hosted platform for AI agents. Your agent sends it traces and its catalog of tools and skills. Ratel reads that traffic and shows you what the agent gets wrong, what people ask it for, and which changes would make it find and finish more.

It is for anyone building or running an agent who wants to see how it behaves and keep that data on their own machines. It runs as one application and one Postgres database, and it needs nothing else:

- **Console:** the pages you read and act on. See [What is in the console](#what-is-in-the-console).
- **Ingest and catalog APIs:** OTLP traces and logs, SDK events, catalog pull, skills and intent graph sync, authenticated with per-project API keys.
- **Background jobs:** a durable queue in Postgres, drained every minute inside the application. There is no separate worker or scheduler to run.
- **Readings:** what Ratel works out from the traffic, as jobs over a ledger of your agent's turns: Agent health signals, workflows and self-corrections, topics, intent clusters and the intent graph, the tool explorer, and match quality.

Model keys are optional. With no key, Ratel makes no outbound model call. The readings that need a model report themselves skipped, workflows keep their tool-order names, and topics are named from their own asks.

## Quick Start

**You need** Docker with Compose 2.24 or later.

### On your machine

```sh
git clone https://github.com/ratel-ai/ratel.git
cd ratel
docker compose up -d --build --wait
```

Open `http://localhost:3000`. The first build takes a few minutes, and no configuration is needed.

### Explore with demo data (optional)

```sh
docker compose --profile demo run --rm demo
```

A fresh install seeds this sample project, Site Copilot, by itself the first time the console opens with no project: 30 days of agent activity, marked as sample data, seeded once per organization (deleting it does not bring it back). Some pages fill in over the next couple of minutes. This command replaces it with a fresh copy, or restores it after a delete.

### On a server

> **The console has no login.** Anyone who reaches it is an admin. Ratel binds to `127.0.0.1` only: keep it behind your own proxy with authentication and TLS.

```sh
git clone https://github.com/ratel-ai/ratel.git
cd ratel
cp .env.example .env
```

Set these in `.env` **before the first start**. Generate each secret with `openssl rand -hex 32`:

```sh
RATEL_ORG_NAME=Acme
BASE_URL=https://ratel.example.com
POSTGRES_PASSWORD=<generated>
TRACE_SIGNALS_HASH_SALT=<generated>
```

Then start it with `docker compose up -d --build --wait`. Point your proxy at `127.0.0.1:3000`, and configure it so that:

- `/v1`, `/v2`, `/api/v1` and `/api/v2` pass through without your login, because the SDKs authenticate with API keys.
- Everything else requires your login.
- It preserves `Host` or sets `X-Forwarded-Host`, otherwise console actions fail.

Model keys are optional, and every field is explained in `.env.example`.

### Everyday commands

```sh
docker compose up -d --build --wait    # start, or update after a git pull; migrations run on boot
docker compose down                    # stop, keeping your data
docker compose logs -f web worker      # follow the logs
docker compose down --volumes          # stop and DELETE ALL DATA
```

Two containers run the app from the same image: `web` serves the console and the API and only queues background work, and `worker` runs it (analysis, sweeps, model calls), so a slow job never holds up a request. To run everything in one container instead, start the image without `APP_ROLE`.

`POSTGRES_PASSWORD` is read only when the database is first created. Changing it later means deleting the data with the last command.

## What is in the console

An organization holds projects, and each project is one agent's view:

| Page | What it shows |
|---|---|
| **Overview** | The project at a glance: activity over the last 7 or 30 days, and what needs attention. |
| **Agent health** | What your agent gets wrong. **Summary** lists the issues, **Tasks** follows what people tried to do down to each session, and **Self-corrections** lists the times the agent retried, switched tools, gave up or apologized. The Summary also prints as a report. |
| **Traces** | Every run step by step, with spans, operations and logs, and two traces side by side. |
| **Catalog** | Every **tool** and **skill** your agent can use, and how each one is found. **Test a search** ranks a prompt against the live catalog, with what-if edits. |
| **Intents** | What people ask for. **All intents** lists the topics, **Flows** shows what people want next, ask after ask, and **Map** lays the intents out. |
| **Improvements** | **Fixes** is the one list of changes that would make your agent find and finish more. **Quality** measures how well searches find the right tool, with misses, description rewrites and experiments. **Adaptive ranking** puts the tool your agent needs first, using what people asked before. |
| **Settings** | Projects general settings, **API keys**, SDK events under **Developer**, and a danger zone. |

## Repo layout

```
apps/
└── web/                       # @ratel/platform: the console and APIs
packages/
├── brand/                     # @ratel/brand: palette, fonts and logo assets
├── design-system/             # @ratel/design-system: semantic tokens and UI primitives
└── sdk/                       # Ratel SDK
scripts/                       # Repository checks and release tooling
docs/
├── adr/                       # Architecture decision records
└── assets/                    # Images and other static assets
ee/                            # Manifest for the Enterprise modules
```

The application's own layout and commands are in [apps/web/README.md](apps/web/README.md), and the layers of its core in [apps/web/lib/README.md](apps/web/lib/README.md).

## Development

### Ratel Platform

Prerequisites: Node 24+ and pnpm 10.28+, with Docker for the platform's Postgres. 

- [apps/web/README.md](apps/web/README.md)

### Ratel SDK

Prerequisites: The Rust workspace and the SDKs' native addons need Rust stable (pinned via `rust-toolchain.toml`). The Python SDK also needs Python 3.11 and [`uv`](https://docs.astral.sh/uv/).

- [packages/sdk/README.md](packages/sdk/README.md)

## Contributing

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [AGENTS.md](AGENTS.md): for coding agents working in this repo
- [SECURITY.md](SECURITY.md): how to report a vulnerability, and which versions get fixes

## License

The `ratel-ai-core` engine is licensed under [Apache-2.0](LICENSE-APACHE), an explicit patent grant for the engine others embed. Everything else (the platform application, SDKs, telemetry helpers, examples) is [MIT](LICENSE.md). See [ADR-0009](docs/adr/0009-licensing.md) for the rationale.
