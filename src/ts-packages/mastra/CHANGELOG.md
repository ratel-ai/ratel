# @agentified/mastra

## 3.0.0

### Minor Changes

- 3a6e9ca: Add observer hooks for context assembly + agent steps. New `ag.on("context:assembled" | "recall", cb)` on the SDK and `mag.on("step", cb)` on the Mastra adapter let consumers subscribe once and receive typed events with a disposer return. Additive — no breaking changes.

### Patch Changes

- Updated dependencies [3a6e9ca]
  - agentified@0.3.0

## 2.0.0

### Minor Changes

- 1971ee8: Add deferred tool loading with `alwaysInclude` flag, MCP tool type support, and strategy delegation to server

### Patch Changes

- Updated dependencies [1971ee8]
- Updated dependencies [57e0744]
  - agentified@0.2.0

## 1.0.0

### Patch Changes

- Updated dependencies [de0eb19]
  - agentified@0.1.0

## 0.0.9

### Patch Changes

- 6b28862: refactor: move summary message construction from core to SDK, add summaryRange, remove annotateSummary
- Updated dependencies [6b28862]
  - agentified@0.0.9

## 0.0.8

### Patch Changes

- ca6c11b: feat: add getMessages agent tool, summary annotation, first-message preservation
- Updated dependencies [ca6c11b]
  - agentified@0.0.8

## 0.0.7

### Patch Changes

- b81e856: add recall, summary strategies, limitTokens to context assembly
- Updated dependencies [b81e856]
  - agentified@0.0.7

## 0.0.6

### Patch Changes

- Add custom headers support to connect() for authenticated servers
- Updated dependencies
  - agentified@0.0.6

## 0.0.5

### Patch Changes

- a2ec18c: persistent conversations: dataset-scoped tools, message persistence, context retrieval, session management
- 181d70d: Review interface
- Updated dependencies [a2ec18c]
- Updated dependencies [181d70d]
  - agentified@0.0.5

## 0.0.5-beta.7

### Patch Changes

- 181d70d: Review interface
- Updated dependencies [181d70d]
  - agentified@0.0.5-beta.7

## 0.0.5-beta.0

### Patch Changes

- persistent conversations: dataset-scoped tools, message persistence, context retrieval, session management
- Updated dependencies
  - @agentified/sdk@0.0.5-beta.0

## 0.0.4

### Patch Changes

- 34fb32a: add package documentation
- Updated dependencies [34fb32a]
  - @agentified/sdk@0.0.4

## 0.0.3

### Patch Changes

- c20ff7c: bump version
- c20ff7c: First changeset bump
- Updated dependencies [c20ff7c]
- Updated dependencies [c20ff7c]
  - @agentified/sdk@0.0.3
