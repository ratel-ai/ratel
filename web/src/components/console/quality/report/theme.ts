import type { CSSProperties } from "react";

/**
 * One set of chart tokens, resolved twice.
 *
 * Every quality chart draws with `var(--q-*)` rather than a Tailwind class, for
 * a single reason: the console is dark-only and the report is printed on white
 * paper, and maintaining two copies of a bar chart guarantees they drift. The
 * scope wrapper swaps the values; the components never know which surface they
 * are on.
 *
 * The accents are the brand's own (`packages/brand/src/theme.css`). Coral is
 * Ratel throughout, and the baseline arm takes the amber from the data-viz ramp
 * chosen because the two stay distinguishable in greyscale, which is how a
 * good share of a printed report is actually read.
 */

export type QualitySurface = "screen" | "print";

const SCREEN: Record<string, string> = {
  "--q-ink": "var(--color-cream)",
  "--q-ink-dim": "var(--color-cream-dim)",
  "--q-muted": "var(--color-warm-muted)",
  "--q-line": "color-mix(in srgb, var(--color-cream) 12%, transparent)",
  "--q-track": "color-mix(in srgb, var(--color-cream) 8%, transparent)",
  "--q-surface": "color-mix(in srgb, var(--color-forest) 20%, transparent)",
  "--q-border": "var(--color-forest-300)",
  "--q-accent": "var(--color-coral)",
  "--q-accent-soft": "color-mix(in srgb, var(--color-coral) 22%, transparent)",
  "--q-baseline": "var(--color-ctx-tools)",
  "--q-baseline-soft": "color-mix(in srgb, var(--color-ctx-tools) 22%, transparent)",
  "--q-good": "var(--color-green)",
  "--q-absent": "color-mix(in srgb, var(--color-cream) 22%, transparent)",
  // Rank ramp, brightest first: on a dark canvas "more important" is more light.
  "--q-rank-1": "#ff7d45",
  "--q-rank-2": "#c8552f",
  "--q-rank-3": "#8a3d24",
  "--q-rank-none": "#615f58",
  // Label ink for text set inside a fill, picked by the fill's luminance. The
  // screen ramp runs brightest-first, so the bands that take the "on a light
  // fill" ink here are the ramp's DARKEST steps and need light ink, not the
  // same near-black the bright steps take. Setting both to one value put the
  // "4th or lower" and "not in the list" labels at under 3:1 on their own fill.
  "--q-on-fill-dark": "#1a0d07",
  "--q-on-fill-light": "var(--color-cream)",
};

const PRINT: Record<string, string> = {
  "--q-ink": "#0b0b0b",
  "--q-ink-dim": "#2a2a28",
  "--q-muted": "#52514e",
  "--q-line": "#e8e7e2",
  "--q-track": "#f2f1ec",
  "--q-surface": "#ffffff",
  "--q-border": "#e3e2dd",
  "--q-accent": "#c4431f",
  "--q-accent-soft": "#f7ded4",
  "--q-baseline": "#b7791f",
  "--q-baseline-soft": "#f6e8cf",
  "--q-good": "#1b7a45",
  // Darker than the empty-slot track it sits in, or the misses read as absence
  // of data rather than as the result they are.
  "--q-absent": "#b6b5ae",
  // Rank ramp, darkest first: on white paper "more important" is more ink. This
  // is a selected dark/light pair, not an automatic flip of the screen ramp,
  // because inverting it would bury rank 1 against its own surface.
  "--q-rank-1": "#7d2b0f",
  "--q-rank-2": "#b8532b",
  "--q-rank-3": "#d97d55",
  "--q-rank-none": "#9d9c94",
  "--q-on-fill-dark": "#ffffff",
  "--q-on-fill-light": "#2a1a10",
};

export function qualityTokens(surface: QualitySurface): CSSProperties {
  return (surface === "print" ? PRINT : SCREEN) as CSSProperties;
}

/**
 * Which colour an arm draws in.
 *
 * The baseline is the incumbent, so it keeps the neutral amber and Ratel keeps
 * coral wherever it appears. Deciding this once means a reader who learns the
 * legend on the first chart does not have to re-learn it on the fourth.
 */
export function armColor(arm: string, baselineArm: string | null): string {
  return arm === baselineArm ? "var(--q-baseline)" : "var(--q-accent)";
}

/**
 * Where a tool was found, as an ordered scale.
 *
 * Each surface's steps fall in BOTH lightness and saturation as rank worsens.
 * Lightness alone is not enough on the dark console: a pale-but-dull first band
 * beside a vivid second one sends the eye to the wrong band, which is the
 * opposite of what an ordered scale is for.
 *
 * Rank is ordinal, so it takes a SEQUENTIAL ramp (one hue, monotonic lightness)
 * rather than categorical hues: the reader should see "further down the list"
 * without consulting a key. `none` sits outside the ramp in neutral gray because
 * "we never returned it" is not a worse position, it is a different outcome.
 *
 * Each surface has its own direction, chosen rather than flipped: darkest-first
 * on paper, brightest-first on the dark console, so rank 1 is always the
 * strongest mark against its own background. Both directions were checked for
 * monotonic lightness and for a legible weakest step (2.7:1 on paper).
 */
/**
 * Three bands, not one per rank.
 *
 * The decision this chart supports has three outcomes: we led with it, it was
 * near the top, or it was buried. Splitting 2nd from 3rd adds a legend row and a
 * ramp step without changing anyone's mind, and a four-step ramp cannot keep its
 * faintest step legible against either surface.
 */
export const RANK_BANDS = [
  { key: "1", label: "we led with it", color: "var(--q-rank-1)" },
  { key: "23", label: "2nd or 3rd", color: "var(--q-rank-2)" },
  { key: "4", label: "4th or lower", color: "var(--q-rank-3)" },
  { key: "none", label: "not in the list", color: "var(--q-rank-none)" },
] as const;

export type RankBandKey = (typeof RANK_BANDS)[number]["key"];
