import {
  CircleSlash,
  Handshake,
  type LucideIcon,
  MessageCircleQuestion,
  MessageCircleWarning,
  Repeat,
  Search,
  Shuffle,
  Undo2,
} from "lucide-react";
import type { PlainKind } from "@/lib/readings/trace-signals/self-corrections/kinds";

/**
 * One mark and one short word per kind of self-correction, so the kinds read
 * at a glance in a strip (the long label and its meaning stay in the Panel).
 * Where a kind matches an issue's own icon (a retry, a switch, a backtrack),
 * it wears the same one.
 */
export const KIND_ICONS: Readonly<Record<PlainKind, LucideIcon>> = {
  retried: Repeat,
  switched: Shuffle,
  gave_up: CircleSlash,
  searched_again: Search,
  asked_again: MessageCircleQuestion,
  apologized: MessageCircleWarning,
  conceded: Handshake,
  backtracked: Undo2,
};

/** The kinds in one word or two, for the strip. */
export const KIND_SHORT: Readonly<Record<PlainKind, string>> = {
  retried: "Retried",
  switched: "Switched",
  gave_up: "Gave up",
  searched_again: "Searched again",
  asked_again: "Asked again",
  apologized: "Apologized",
  conceded: "Conceded",
  backtracked: "Backtracked",
};
