import { Mastra } from "@mastra/core/mastra";
import { appAgent } from "./agents/app-agent.js";

export const mastra = new Mastra({
  agents: { "app-agent": appAgent },
});
