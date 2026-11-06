import { existsSync } from "node:fs";
import { join } from "node:path";

export type HoneybadgerPose =
  | "searching"
  | "tangled"
  | "sleeping"
  | "construction"
  | "celebration"
  | "waving";

const BADGER_ASSET_FILES: Record<HoneybadgerPose, string> = {
  searching: "searching.png",
  tangled: "tangled.png",
  sleeping: "sleeping.png",
  construction: "construction.png",
  celebration: "celebration.png",
  waving: "waving.png",
};

export function getBadgerAssetSource(
  pose: HoneybadgerPose,
  publicDirectory?: string,
): string | null {
  const filename = BADGER_ASSET_FILES[pose];
  const publicDirectories = publicDirectory
    ? [publicDirectory]
    : [join(process.cwd(), "public"), join(process.cwd(), "apps", "web", "public")];

  return publicDirectories.some((directory) => existsSync(join(directory, "badgers", filename)))
    ? `/badgers/${filename}`
    : null;
}
