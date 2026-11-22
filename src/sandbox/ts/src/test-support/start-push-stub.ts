import { parseArgs } from "node:util";
import { startPushStub } from "./push-stub.js";

// Starts the push API stub on a fixed port, for a manual or recorded
// `ratel sandbox push --url http://127.0.0.1:<port>` with RATEL_API_KEY=rtl_<anything>.
// It prints each call it gets. Test support only: not the Ratel server.
//
//   pnpm --filter @ratel-ai/sandbox push-stub -- --port 4200

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4200" },
    status: { type: "string", default: "building" },
  },
});
const status = values.status as "building" | "ready" | "failed";
const stub = await startPushStub({ port: Number(values.port), status });
process.stdout.write(`push API stub on ${stub.url}\n`);
let seen = 0;
setInterval(() => {
  for (const call of stub.calls.slice(seen)) {
    const what = call.bytes !== undefined ? `${call.bytes} bytes` : "json";
    process.stdout.write(`  ${call.method} ${call.path} (${what})\n`);
  }
  seen = stub.calls.length;
}, 100);
