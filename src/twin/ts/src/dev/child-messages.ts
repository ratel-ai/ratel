import type { Manifest } from "../manifest.js";

/** What the `ratel dev` parent asks its long-lived child worker over IPC. */
export type ChildRequest = {
  readonly id: number;
  readonly kind: "manifest";
  readonly root: string;
  readonly files: readonly string[];
  readonly build?: Manifest["build"];
};

export type ChildReply =
  | {
      readonly id: number;
      readonly ok: true;
      readonly kind: "manifest";
      readonly manifest: Manifest;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };
