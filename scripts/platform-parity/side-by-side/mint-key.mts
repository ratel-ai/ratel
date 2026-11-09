// A project API key for the side-by-side MCP calls (temporary parity harness, RTL-45). This
// edition stores no plaintext key, so the script makes its own. Run with apps/web as the working
// directory and DATABASE_URL set; prints the key once, to the caller's file, never to a log.
import { generateApiKey } from "@/lib/platform/api-keys";
import { createApiKey } from "@/lib/platform/projects/queries";

const projectId = process.argv[2];
if (!projectId) throw new Error("usage: mint-key.mts <projectId>");
const key = generateApiKey();
await createApiKey({ projectId, name: "parity-side-by-side", keyHash: key.hash, keyPrefix: key.prefix });
process.stdout.write(key.plaintext);
process.exit(0);
