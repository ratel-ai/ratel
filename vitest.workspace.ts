import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/sdk",
  "packages/runtime",
  "packages/react",
  "packages/cli",
]);
