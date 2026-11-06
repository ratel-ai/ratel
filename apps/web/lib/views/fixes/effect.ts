/**
 * A fix's effect in one compact figure, the way a row shows it ("3 → 1
 * calls", "+40 pts found", "−1 failed call"), split into the figure and its
 * unit so the Panel can set the figure large. Pure, client-safe.
 */

export interface CompactEffect {
  /** "3 → 1", "+40 pts", "−1", "−1.2 s". */
  figure: string;
  /** "calls", "found", "failed call", "waiting"; empty when the figure says it all. */
  unit: string;
}

const NUMBER = String.raw`[−+-]?\$?\d[\d.,]*(?:[kKM]\b)?(?: ?(?:ms|s|min|h)\b)?`;
const LEADING_FIGURE = new RegExp(`^(${NUMBER})(.*)$`);

/** A drafted change's effect chip ("3 calls → 1", "−1 tool in every list") as a figure and its unit. */
export function compactEffect(text: string): CompactEffect {
  const flat = text.replace(/\s+/g, " ").trim();
  const calls = /^(\d+(?:\.\d+)?) calls? → 1$/.exec(flat);
  if (calls) return { figure: `${calls[1]} → 1`, unit: "calls" };
  const lead = LEADING_FIGURE.exec(flat);
  if (!lead) return { figure: flat, unit: "" };
  return { figure: lead[1]!.trim(), unit: unitOf(lead[2]!) };
}

function unitOf(rest: string): string {
  const words = rest
    .trim()
    // A share of the total in brackets is the derivation's, not the row's.
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s*total$/, "")
    .replace(/^\/(\w+) waiting$/, "waiting per $1")
    .replace(/ in every (tool )?list$/, " per list")
    .trim();
  return words;
}

/** The figure and unit as one line: "3 → 1 calls". */
export function effectLine(effect: CompactEffect): string {
  return effect.unit ? `${effect.figure} ${effect.unit}` : effect.figure;
}

/** Whether the figure falls (fewer calls, a minus) or rises; null when it says neither. */
export function effectDirection(figure: string): "up" | "down" | null {
  if (/^[−-]/.test(figure) || /→ 1$/.test(figure)) return "down";
  if (/^\+/.test(figure)) return "up";
  return null;
}
