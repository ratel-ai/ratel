import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ratel/brand"],
  output: "standalone",
};

export default nextConfig;
