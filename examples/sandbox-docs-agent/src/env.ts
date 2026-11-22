import { existsSync } from "node:fs";

// Loads the example's .env (git-ignored) once, like `ratel sandbox dev` does for a sandbox.
if (existsSync(".env")) process.loadEnvFile(".env");
