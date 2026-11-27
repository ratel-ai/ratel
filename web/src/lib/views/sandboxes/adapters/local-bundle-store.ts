import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, link, mkdir, open, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BundleStore } from "@/lib/contracts/bundle-store";

/** Bundles as files of one folder. Every process that takes pushes or builds must see the folder. */
export function createLocalBundleStore(folder: string): BundleStore {
  const root = resolve(folder);
  const pathOf = (key: string): string => {
    const path = resolve(join(root, key));
    if (!path.startsWith(root + sep)) throw new Error("the bundle key leaves the folder");
    return path;
  };
  return {
    async uploadTarget() {
      return null;
    },

    async put(key, body, bundle) {
      const path = pathOf(key);
      if (await exists(path)) return { ok: false, reason: "exists" };
      await mkdir(dirname(path), { recursive: true });
      const part = `${path}.${randomUUID()}.part`;
      try {
        if (!(await writeExactly(part, body, bundle))) return { ok: false, reason: "mismatch" };
        // A link fails when the path exists, so a second upload cannot replace the first.
        await link(part, path);
        return { ok: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return { ok: false, reason: "exists" };
        }
        throw error;
      } finally {
        await rm(part, { force: true });
      }
    },

    async open(key) {
      const path = pathOf(key);
      return (await exists(path)) ? createReadStream(path) : null;
    },

    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}

async function writeExactly(
  path: string,
  body: AsyncIterable<Uint8Array>,
  bundle: { sha256: string; bytes: number },
): Promise<boolean> {
  const file = await open(path, "wx");
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of body) {
      bytes += chunk.length;
      if (bytes > bundle.bytes) return false;
      hash.update(chunk);
      await file.write(chunk);
    }
    return bytes === bundle.bytes && hash.digest("hex") === bundle.sha256;
  } finally {
    await file.close();
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
