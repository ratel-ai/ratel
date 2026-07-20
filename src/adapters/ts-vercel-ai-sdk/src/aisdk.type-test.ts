// Compile-only assertions that the adapter's helper types line up with `ai`'s,
// so a drift in the AI SDK surface fails `tsc -p tsconfig.type-tests.json`
// rather than at a host's call site.
import { ratel } from "@ratel-ai/sdk";
import type { ModelMessage, PrepareStepFunction, ToolSet } from "ai";
import { aiSdk } from "./aisdk.js";

const view = ratel().adaptTo(aiSdk());

// `modelTools()` returns a valid AI SDK ToolSet — hand it straight to
// generateText / streamText / ToolLoopAgent with no cast.
const toolset: ToolSet = view.modelTools();

// `prepareStep` drops into the prepareStep slot for any TOOLS: the structurally
// narrow `{ stepNumber, messages }` parameter keeps it assignable to
// `PrepareStepFunction<TOOLS>` without a per-TOOLS specialization or a cast.
const prepare: PrepareStepFunction<ToolSet> = view.prepareStep;

// `appendRecall` mutates-and-returns the same `ModelMessage[]`, asynchronously.
const appended: Promise<ModelMessage[]> = view.appendRecall([]);

void toolset;
void prepare;
void appended;
