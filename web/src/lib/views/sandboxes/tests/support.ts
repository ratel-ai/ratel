import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { RatelYaml } from "../domain/config";

export const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

/** A migrated database with two projects of one organization. */
export async function createSandboxDb() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  // biome-ignore lint/suspicious/noExplicitAny: PGlite stands in for the Postgres client
  return { client, db: drizzle(client, { schema }) as any };
}

export type TarEntry = { name: string; body?: string; type?: string; link?: string };

/** A gzip tar of these entries. */
export function tarGz(entries: TarEntry[]): Buffer {
  const blocks = entries.flatMap(({ name, body = "", type = "0", link = "" }) => {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write(`${Buffer.byteLength(body).toString(8).padStart(11, "0")}\0`, 124);
    header.write("        ", 148);
    header.write(type, 156);
    header.write(link, 157, 100);
    header.write("ustar\x0000", 257);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
    data.write(body);
    return [header, data];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

export function bundleInfo(bundle: Buffer) {
  return { sha256: createHash("sha256").update(bundle).digest("hex"), bytes: bundle.length };
}

/** A parsed ratel.yaml of an HTTP agent. */
export const CONFIG = {
  name: "support-agent",
  run: { mode: "http", port: 8080, timeoutSeconds: 120 },
  input: { example: { message: "Refund order 42" } },
  params: { model: { type: "enum", options: ["small", "large"], default: "small" } },
  secrets: ["OPENAI_API_KEY"],
  tools: { lookup_order: { mode: "live" }, refund_order: { mode: "simulated" } },
} satisfies RatelYaml;
export const IMAGE = { digest: `sha256:${"c".repeat(64)}`, platform: "linux/amd64" };
export const COMMIT = "b".repeat(40);
