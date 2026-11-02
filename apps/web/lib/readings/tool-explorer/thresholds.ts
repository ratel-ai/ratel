/**
 * The two bounds the explorer and the crafter read the same way, declared once.
 */

/** A hop this sure is a dependency: the second tool followed the first in at least this share of its calls. The explorer keeps such hops ahead of busier, looser ones, draws them as arrows, and the crafter proposes on them. */
export const SURE_HOP_P = 0.9;

/** A pair whose Jaccard lower bound (Wilson) reaches this is "always together": the explorer badges it and the crafter nominates it for a merge. */
export const ALWAYS_TOGETHER_LOW = 0.9;
