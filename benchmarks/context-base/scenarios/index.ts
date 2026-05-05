import type { Scenario } from "../lib/types.js";
import { retrievalScenarios } from "./single-turn-retrieval.js";
import { actionScenarios } from "./single-turn-actions.js";
import { multiTurnScenarios } from "./multi-turn.js";
import { negativeScenarios } from "./negative.js";
import { ambiguousScenarios } from "./ambiguous.js";
import { crossDomainScenarios } from "./cross-domain.js";
import { distractorResistanceScenarios } from "./distractor-resistance.js";
import { scaleStressScenarios } from "./scale-stress.js";

export {
  retrievalScenarios,
  actionScenarios,
  multiTurnScenarios,
  negativeScenarios,
  ambiguousScenarios,
  crossDomainScenarios,
  distractorResistanceScenarios,
  scaleStressScenarios,
};

export const scenarios: Scenario[] = [
  ...retrievalScenarios,
  ...actionScenarios,
  ...multiTurnScenarios,
  ...negativeScenarios,
  ...ambiguousScenarios,
  ...crossDomainScenarios,
  ...distractorResistanceScenarios,
  ...scaleStressScenarios,
];
