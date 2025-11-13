# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Agentified** is a newly initialized Node.js project using CommonJS modules. The project structure and codebase are currently being developed.

## Development Commands

### Setup and Installation
```bash
npm install          # Install dependencies
```

### Testing
```bash
npm test             # Run test suite
```

### Build and Development
Currently, there are no build or lint commands configured. Add these as the project develops:
- Consider adding a linter (ESLint) for code quality
- Consider adding a test framework (Jest, Mocha) for proper test coverage

## Project Structure

The repository is in its initial stages with minimal structure. As the project grows:
- Organize source code in a `src/` directory
- Place tests in a `tests/` or `__tests__/` directory
- Consider adding `lib/` for any compiled or generated code

## Key Information

- **Module System**: CommonJS (`"type": "commonjs"` in package.json)
- **Repository**: https://github.com/agentified/agentified
- **Main Entry**: `index.js` (to be created)

## Next Steps for Development

1. Create the main entry point (`index.js`)
2. Define project scope and add appropriate dependencies
3. Implement a testing framework and write tests
4. Add a linter (ESLint) for code quality
5. Consider adding a build process if needed
