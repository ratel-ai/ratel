# @agentified/fe-client

## 0.1.0

### Minor Changes

- 3a6e9ca: Add observer hooks for context assembly + agent steps. New `ag.on("context:assembled" | "recall", cb)` on the SDK and `mag.on("step", cb)` on the Mastra adapter let consumers subscribe once and receive typed events with a disposer return. Additive — no breaking changes.

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
