import pino, { type Logger } from "pino";

/**
 * The same line shape as the web app's `getLogger(module)`: pino JSON lines
 * with a `module` field. Frames and payloads are never logged, only ids,
 * types and counts.
 */
const root = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: "ratel-gateway" },
  redact: ["token", "*.token", "authorization", "*.authorization"],
});

export type { Logger };

export function getLogger(module: string): Logger {
  return root.child({ module });
}
