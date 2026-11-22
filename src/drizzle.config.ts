import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside Next, so load env explicitly (.env.local first).
config({ path: ".env.local" });
config({ path: ".env" });

// Each module owns its schema fragment (ADR-0030): lib/<layer>/schema.ts for one-module layers
// such as jobs, lib/<layer>/<module>/schema.ts for the rest. One glob covers both depths: the
// drizzle-kit CLI keeps only the last --schema flag, so the regenerate script cannot pass two.
// The barrel lib/platform/db/tables.ts is deliberately not named schema.ts so it is not read twice.
export default defineConfig({
  dialect: "postgresql",
  schema: ["./lib/**/schema.ts"],
  out: "./lib/platform/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
