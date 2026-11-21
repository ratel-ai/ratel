import { existsSync } from "node:fs";

// Loads the example's .env (git-ignored) once, like `ratel dev` does for a twin.
if (existsSync(".env")) process.loadEnvFile(".env");
