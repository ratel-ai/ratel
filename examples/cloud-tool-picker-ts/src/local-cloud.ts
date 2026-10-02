// A local stand-in for the two Ratel Cloud endpoints a cloud catalog uses, so
// the example runs with no API key. It speaks the real wire contracts
// (ADR-0026, ADR-0027):
//
//   PUT  /api/v1/catalog/snapshot  { source_id, tools }      -> { sourceId, catalogVersion, tools, unchanged }
//   POST /v1/tools/pick            { query, mode, top_k }    -> { mode, tools: [{ id, name, description, score }], confident }
//
// Its "ranking" is a toy: word overlap for `instant`, plus a hard-coded intent
// table standing in for the system-one judge in `precise` / `exhaustive`. It
// shows the plumbing, not ranking quality. Set RATEL_CLOUD_URL to use Cloud.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

interface SyncedTool {
  id: string;
  name: string;
  description: string;
}

/** Query phrases -> words a tool should mention to satisfy that intent. */
const INTENTS: [string, string[]][] = [
  ["money back", ["refund", "return funds"]],
  ["charged twice", ["refund", "return funds"]],
];

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);

function rank(query: string, mode: string, tools: SyncedTool[], topK: number) {
  const q = words(query);
  const wanted = INTENTS.filter(([phrase]) => query.toLowerCase().includes(phrase)).flatMap(
    ([, w]) => w,
  );
  return tools
    .map((t) => {
      const text = `${t.name.replace(/_/g, " ")} ${t.description}`.toLowerCase();
      const overlap = [...words(text)].filter((w) => q.has(w)).length / Math.max(q.size, 1);
      const judged = wanted.some((w) => text.includes(w)) ? 0.9 : 0.05 * overlap;
      return { ...t, score: mode === "instant" ? overlap : judged };
    })
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, topK);
}

export interface LocalCloud {
  url: string;
  close: () => Promise<void>;
}

export async function startLocalCloud(): Promise<LocalCloud> {
  const catalogs = new Map<string, { version: string; tools: SyncedTool[] }>();
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw);
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "PUT" && req.url === "/api/v1/catalog/snapshot") {
        const version = createHash("sha256").update(raw).digest("hex").slice(0, 12);
        const unchanged = catalogs.get(body.source_id)?.version === version;
        catalogs.set(body.source_id, { version, tools: body.tools });
        return reply(200, {
          sourceId: body.source_id,
          catalogVersion: version,
          tools: body.tools.length,
          unchanged,
        });
      }
      if (req.method === "POST" && req.url === "/v1/tools/pick") {
        const tools = [...catalogs.values()].flatMap((c) => c.tools);
        if (tools.length === 0) {
          return reply(409, { error: { message: "This project has no tools in its runtime catalog." } });
        }
        return reply(200, {
          mode: body.mode,
          tools: rank(body.query, body.mode, tools, body.top_k),
          confident: body.mode === "instant" ? null : true,
        });
      }
      reply(404, { error: { message: "not found" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
