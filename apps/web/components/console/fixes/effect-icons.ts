import {
  Bot,
  Braces,
  CircleDollarSign,
  CircleX,
  ListMinus,
  type LucideIcon,
  Timer,
  WholeWord,
  Wrench,
} from "lucide-react";
import type { EffectChip } from "@/lib/views/fixes/crafter-types";

/**
 * One mark per thing a fix moves, the same marks the rest of the console
 * uses: a tool call is the tool's wrench, waiting a timer, a model call the
 * agent's bot. Tokens are words, so they get a word, not coins, which read as
 * money beside the dollar.
 */
export const EFFECT_ICONS: Readonly<Record<EffectChip["icon"], LucideIcon>> = {
  calls: Wrench,
  failures: CircleX,
  list: ListMinus,
  schema: Braces,
  time: Timer,
  model: Bot,
  cost: CircleDollarSign,
  tokens: WholeWord,
};

/** What each mark stands for, said to a screen reader before its figure. */
export const EFFECT_ICON_LABELS: Readonly<Record<EffectChip["icon"], string>> = {
  calls: "Tool calls",
  failures: "Failed calls",
  list: "Tool list",
  schema: "Schema",
  time: "Waiting",
  model: "Model calls",
  cost: "Cost",
  tokens: "Tokens",
};
