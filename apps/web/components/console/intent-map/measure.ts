import { estimateMeasure, type Measure } from "@/lib/views/intents/map/map-geometry";

export type TextMeasures = { sans: Measure; mono: Measure };

/** The size labels are measured at; a label at another size scales its width by size over this. */
export const MEASURE_PX = 12;

/**
 * Label widths as the browser draws them: the medium-weight sans of an ask's
 * name and the mono of a tool's, at `MEASURE_PX`. Measured on a canvas once the
 * page fonts are ready, and cached; an estimate stands in where there is no
 * canvas.
 */
export async function createTextMeasures(): Promise<TextMeasures> {
  const fallback = { sans: estimateMeasure(MEASURE_PX), mono: estimateMeasure(MEASURE_PX, true) };
  if (typeof document === "undefined") return fallback;
  await document.fonts?.ready;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return fallback;
  const root = getComputedStyle(document.documentElement);
  const sans = root.getPropertyValue("--font-sans").trim() || "sans-serif";
  const mono = root.getPropertyValue("--font-mono").trim() || "monospace";
  const measurer = (font: string): Measure => {
    const cache = new Map<string, number>();
    return (text) => {
      let width = cache.get(text);
      if (width === undefined) {
        context.font = font;
        width = context.measureText(text).width;
        cache.set(text, width);
      }
      return width;
    };
  };
  return {
    sans: measurer(`500 ${MEASURE_PX}px ${sans}`),
    mono: measurer(`${MEASURE_PX}px ${mono}`),
  };
}
