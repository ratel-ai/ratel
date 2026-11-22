import { Bot, CircleHelp, Eye, type LucideIcon } from "lucide-react";

/**
 * How the right answer for a search was established, as one glyph, one colour and
 * one sentence — defined ONCE and used everywhere it appears.
 *
 * It used to be defined twice. The per-search rows in a proposal drew these three
 * icons, while the evidence band above them drew plain coloured dots, and the
 * rows' own comment claimed "the bar up there teaches these rows without a
 * legend" — which was simply not true of a dot. A reader saw a gavel on one row
 * and a purple dot on the band and had no way to know they meant the same thing;
 * the colour matched and the shape did not, which is worse than either matching
 * alone, because it looks deliberate.
 *
 * So the band shows the glyph too. The dot carried no information a colour was
 * not already carrying, and the glyph is the part that can be recognised again
 * two panels later.
 */
export interface TierStyle {
  Icon: LucideIcon;
  /** Text colour for the glyph. */
  tone: string;
  /** Background for the proportional bar, matching `tone`. */
  fill: string;
  /** Two or three words, for the legend. */
  label: string;
  /** What it means, in plain language, for the tooltip. */
  note: string;
}

export const TIERS = {
  invoked: {
    Icon: Eye,
    tone: "text-green",
    fill: "bg-green",
    label: "seen it run",
    note: "We know this is the right tool: the agent went on to run it after searching. This is the strongest evidence there is.",
  },
  judge: {
    // A bot, not a gavel. The gavel was chosen for "judge" and read as a legal
    // proceeding: people saw courtroom, hammer, or nothing they could name, and
    // the one thing it never said was the thing that happened — A MODEL read the
    // request and picked the tool. The colour was always doing more work than the
    // glyph, so only the glyph changes.
    Icon: Bot,
    tone: "text-indigo-300",
    fill: "bg-indigo-300",
    label: "model decided",
    note: "Nobody recorded what the agent ran, so a model read this request against your whole catalog and named the tool it was asking for.",
  },
  reference: {
    Icon: CircleHelp,
    tone: "text-warm-muted",
    // Not forest-300: at 6px the hairline colour disappears into the panel behind
    // it, and a legend nobody can see is worse than no legend.
    fill: "bg-warm-muted/50",
    label: "no answer",
    note: "Nobody has decided this search yet, or the model could not tell which tool it wanted. It is left out of every number and never used to propose a change.",
  },
} as const satisfies Record<string, TierStyle>;

export type TierKey = keyof typeof TIERS;
