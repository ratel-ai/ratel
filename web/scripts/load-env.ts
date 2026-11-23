/**
 * Loads `.env.local`, then `.env`, into the environment, as the app does. A script imports it
 * first: `web/src/config.ts` reads the environment once, so it must be complete before any module
 * resolves the config.
 */
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
