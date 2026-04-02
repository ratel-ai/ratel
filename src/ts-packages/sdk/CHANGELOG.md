# @agentified/sdk

## 0.2.0

### Minor Changes

- 1971ee8: Add deferred tool loading with `alwaysInclude` flag, MCP tool type support, and strategy delegation to server

### Patch Changes

- 57e0744: Fix default search strategy to bm25 in SDK api-client discover and getContext methods

## 0.1.0

### Minor Changes

- de0eb19: Replace `summary` and `recent+summary` strategies with unified `compacted` strategy. Add `pruneThreshold` option to prune long tool results before summarization. Add `compactionStrategy` callback for client-side custom summarization.

## 0.0.9

### Patch Changes

- 6b28862: refactor: move summary message construction from core to SDK, add summaryRange, remove annotateSummary

## 0.0.8

### Patch Changes

- ca6c11b: feat: add getMessages agent tool, summary annotation, first-message preservation

## 0.0.7

### Patch Changes

- b81e856: add recall, summary strategies, limitTokens to context assembly

## 0.0.6

### Patch Changes

- Add custom headers support to connect() for authenticated servers

## 0.0.5

### Patch Changes

- a2ec18c: persistent conversations: dataset-scoped tools, message persistence, context retrieval, session management
- 181d70d: Review interface

## 0.0.5-beta.7

### Patch Changes

- 181d70d: Review interface

## 0.0.5-beta.0

### Patch Changes

- persistent conversations: dataset-scoped tools, message persistence, context retrieval, session management

## 0.0.4

### Patch Changes

- 34fb32a: add package documentation

## 0.0.3

### Patch Changes

- c20ff7c: bump version
- c20ff7c: First changeset bump
