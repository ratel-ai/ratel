// The "real" agent code of the fixture project. `complete` is a fake: no provider call.
export const labelDefaults = {
  model: "anthropic/claude-sonnet-5-5",
  system: "You name agent workflows in three words.",
  maxTokens: 400,
};

export interface LabelInput {
  workflowId: string;
  toolOrder: string[];
}

export interface LabelConfig {
  model: string;
  system: string;
  maxTokens: number;
}

export async function label(input: LabelInput, cfg: LabelConfig) {
  const text = await complete(cfg, `Workflow ${input.workflowId}: ${input.toolOrder.join(" → ")}`);
  return { name: text, model: cfg.model, maxTokens: cfg.maxTokens };
}

async function complete(cfg: LabelConfig, user: string): Promise<string> {
  const words = user.split(/\s+/).length;
  return `${cfg.system.split(" ")[0]} ${words}-word ask, capped at ${cfg.maxTokens} tokens`;
}
