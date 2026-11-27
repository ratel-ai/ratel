/**
 * Where the pushed sandbox bundles are (gzip tars). The web process that takes a push and the
 * worker that builds it must read the same store. A stored bundle never changes.
 */
export type BundleInfo = { sha256: string; bytes: number };

/** Where a client sends a bundle, when not to Ratel. */
export type BundleUploadTarget = { url: string; headers: Record<string, string> };

export type BundlePutResult =
  | { ok: true }
  /** `exists`: the key has a bundle. `mismatch`: the body is not the announced bundle. */
  | { ok: false; reason: "exists" | "mismatch" };

export type BundleStore = {
  /** A target bound to this key and bundle, or null when the client sends the bundle to Ratel. */
  uploadTarget(key: string, bundle: BundleInfo): Promise<BundleUploadTarget | null>;
  /** Stores the body when it is exactly the announced bundle. It never replaces a stored bundle. */
  put(key: string, body: AsyncIterable<Uint8Array>, bundle: BundleInfo): Promise<BundlePutResult>;
  /** The stored bundle, or null when the key has none. */
  open(key: string): Promise<AsyncIterable<Uint8Array> | null>;
};
