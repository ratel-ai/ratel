import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @ratel-ai/sdk loads a native (.node) addon via platform-specific
  // optionalDependencies — keep it and its prebuilds external so the server
  // bundle `require`s them from node_modules at runtime. (This is also why
  // the app depends on the npm-published SDK, not `workspace:*` — Next
  // bundles monorepo-local symlinked packages regardless of this list.)
  serverExternalPackages: [
    "@ratel-ai/sdk",
    "@ratel-ai/sdk-darwin-arm64",
    "@ratel-ai/sdk-darwin-x64",
    "@ratel-ai/sdk-linux-arm64-gnu",
    "@ratel-ai/sdk-linux-x64-gnu",
    "@ratel-ai/sdk-win32-x64-msvc",
  ],
};

export default nextConfig;
