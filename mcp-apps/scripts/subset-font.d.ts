/** subset-font ships no types; the part scripts/build.mts uses. */
declare module "subset-font" {
  interface SubsetOptions {
    targetFormat?: "sfnt" | "woff" | "woff2" | "truetype";
    preserveNameIds?: number[];
    variationAxes?: Record<string, number | { min: number; max: number; default?: number }>;
  }
  export default function subsetFont(
    font: Buffer,
    text: string,
    options?: SubsetOptions,
  ): Promise<Buffer>;
}
