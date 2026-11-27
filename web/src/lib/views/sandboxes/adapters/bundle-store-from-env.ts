import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "@/config";
import { composition } from "@/lib/composition/ports";
import type { BundleStore } from "@/lib/contracts/bundle-store";
import { createLocalBundleStore } from "./local-bundle-store";

/** The edition's bundle store, else a folder of this machine. */
export function bundleStore(): BundleStore {
  return (
    composition.sandboxBundles ??
    createLocalBundleStore(
      getConfig().sandboxes.bundleDir ?? join(tmpdir(), "ratel-sandbox-bundles"),
    )
  );
}
