---
"agentified": minor
"@agentified/mastra": minor
"@agentified/ai-sdk": minor
"@agentified/fe-client": minor
"@agentified/react": minor
---

Add observer hooks for context assembly + agent steps. New `ag.on("context:assembled" | "recall", cb)` on the SDK and `mag.on("step", cb)` on the Mastra adapter let consumers subscribe once and receive typed events with a disposer return. Additive — no breaking changes.
