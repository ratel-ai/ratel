import {
  access,
  mkdir,
  rename as nodeRename,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

export const rename = (from: string, to: string) => nodeRename(from, to);
export { access, mkdir, readdir, readFile, rm, writeFile };
