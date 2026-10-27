import type { NextConfig } from "next";

const eeCompositionTarget =
  process.env.RATEL_COMPOSITION === "cloud"
    ? "../../ee/src/composition.ts"
    : "./lib/composition/ee-absent.ts";

const nextConfig: NextConfig = {
  transpilePackages: ["@ratel/brand", "@ratel/design-system"],
  output: "standalone",
  turbopack: {
    resolveAlias: {
      "#ee-composition": eeCompositionTarget,
    },
  },
};

export default nextConfig;
