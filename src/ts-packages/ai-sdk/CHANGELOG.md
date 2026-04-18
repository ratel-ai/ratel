# @agentified/ai-sdk

## 3.0.0

### Minor Changes

- 3a6e9ca: Add observer hooks for context assembly + agent steps. New `ag.on("context:assembled" | "recall", cb)` on the SDK and `mag.on("step", cb)` on the Mastra adapter let consumers subscribe once and receive typed events with a disposer return. Additive — no breaking changes.

### Patch Changes

- Updated dependencies [3a6e9ca]
  - agentified@0.3.0

## 2.0.0

### Patch Changes

- Updated dependencies [1971ee8]
- Updated dependencies [57e0744]
  - agentified@0.2.0

## 1.0.0

### Minor Changes

- 61eacf5: add Vercel AI SDK adapter

### Patch Changes

- Updated dependencies [de0eb19]
  - agentified@0.1.0
