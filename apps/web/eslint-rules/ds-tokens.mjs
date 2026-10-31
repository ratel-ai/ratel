/**
 * `ratel/ds-tokens`: new UI uses the semantic tokens from DESIGN.md and nothing
 * else. Scoped (in eslint.config.mjs) to the design system and v2 views, so v1
 * screens are untouched until they are rebuilt.
 *
 * The scanner is exported on its own so it can be tested without ESLint.
 */

const COLOR_UTILITY =
  "(?:bg|text|border(?:-[trblxy])?|ring|ring-offset|fill|stroke|from|via|to|outline|divide|placeholder|decoration|shadow|accent|caret)";
const LEGACY = new RegExp(
  `^${COLOR_UTILITY}-(?:canvas|base-deep|forest(?:-\\d+)?|cream(?:-dim)?|warm-muted|coral(?:-deep)?|ink|near-black|paper|indigo(?:-\\d+)?|teal|green|dot-on|ctx-[a-z-]+)(?:\\/\\d+)?$`,
);
const RAW_PALETTE = new RegExp(
  `^${COLOR_UTILITY}-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3})(?:\\/\\d+)?$`,
);
const ARBITRARY_COLOR = new RegExp(`^${COLOR_UTILITY}-\\[(?:#|rgb|hsl|oklch|color-mix)`);
const ARBITRARY_TEXT_PX = /^text-\[(\d+(?:\.\d+)?)px\]$/;

/** The utility itself, without variants (`hover:`, `md:`, `data-x:`) or the important mark. */
function bareUtility(className) {
  return className.slice(className.lastIndexOf(":") + 1).replace(/^!|!$/g, "");
}

/** @returns {("legacy" | "raw" | "small" | "eyebrow")[]} each violation kind once */
export function findDsViolations(value) {
  const found = new Set();
  const utilities = value.split(/\s+/).filter(Boolean).map(bareUtility);
  for (const utility of utilities) {
    if (LEGACY.test(utility)) found.add("legacy");
    else if (RAW_PALETTE.test(utility) || ARBITRARY_COLOR.test(utility)) found.add("raw");
    const px = utility.match(ARBITRARY_TEXT_PX);
    if (px && Number(px[1]) < 12) found.add("small");
  }
  if (
    utilities.includes("uppercase") &&
    utilities.some((utility) => utility.startsWith("tracking-"))
  ) {
    found.add("eyebrow");
  }
  return [...found];
}

export const dsTokensRule = {
  meta: {
    type: "problem",
    docs: { description: "Require DESIGN.md semantic tokens in the design system and v2 views" },
    messages: {
      legacy:
        "Legacy palette class. Use the semantic tokens (bg-app, text-fg-muted, border-line, bg-accent…).",
      raw: "Raw color. Use a semantic token; status and chart colors have their own.",
      small: "Text under 12px. The smallest size is text-xs (12/16).",
      eyebrow:
        "Uppercase tracked label. Section headings are sentence case, text-sm font-semibold.",
    },
    schema: [],
  },
  create(context) {
    function check(node, value) {
      for (const messageId of findDsViolations(value)) context.report({ node, messageId });
    }
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
    };
  },
};
