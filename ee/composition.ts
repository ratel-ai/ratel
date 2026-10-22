import { cloudIdentity } from "@ee/identity";
import { cloudWorkspace } from "@ee/workspace";
import type { CompositionPorts } from "@/lib/contracts/composition";

export const eeComposition: CompositionPorts | null = {
  identity: cloudIdentity,
  workspace: cloudWorkspace,
};
