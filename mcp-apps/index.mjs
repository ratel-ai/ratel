// The built output web/ reads: `pnpm --filter @ratel/mcp-apps build` writes dist/views.json
// (McpAppView[], each view's HTML inline). Run as is (tsx, scripts), the path is this file's own.
// Bundled by Next, `new URL(..., import.meta.url)` makes the file an asset of the server build,
// copied into .next/server/assets: web/ must build this package first (its scripts do).
import { fileURLToPath } from "node:url";

/** Absolute path of dist/views.json. The file is missing until the build has run. */
export const VIEWS_PATH = fileURLToPath(new URL("./dist/views.json", import.meta.url));
