# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Agentified** is a pnpm monorepo containing npm packages for agent development:

- `@agentified/sdk` - Platform API client (Node)
- `@agentified/runtime` - Agent execution from config (Vercel AI SDK)
- `@agentified/react` - React hooks/components (depends on sdk)
- `@agentified/cli` - Developer CLI (depends on runtime + sdk)

## Development Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages
pnpm typecheck        # Type-check all packages
pnpm lint             # Run ESLint
pnpm lint:fix         # Fix lint errors
pnpm test             # Run tests
pnpm test:watch       # Run tests in watch mode
```

### Changesets (versioning)

```bash
pnpm changeset        # Create a changeset
pnpm version          # Apply changesets to versions
pnpm release          # Build and publish packages
```

## Project Structure

```
packages/
  sdk/                # @agentified/sdk
  runtime/            # @agentified/runtime
  react/              # @agentified/react
  cli/                # @agentified/cli
```

## Key Information

- **Package manager**: pnpm with workspaces
- **Module system**: ESM (with CJS builds)
- **Versioning**: Changesets (fixed - all packages same version)
- **Build**: tsup (ESM + CJS + types)
- **Testing**: Vitest
- **Linting**: ESLint v9 flat config
- **Repository**: https://github.com/agentified/agentified

## Package Dependencies

- `sdk`: no internal deps
- `runtime`: peerDep on `ai` (Vercel AI SDK)
- `react`: peerDep on `react`, `@agentified/sdk`
- `cli`: dep on `@agentified/runtime`, `@agentified/sdk`
