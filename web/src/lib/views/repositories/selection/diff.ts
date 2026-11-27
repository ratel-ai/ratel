/** One file of a unified diff, as `git diff` (or GitHub's compare API) prints it. */
export type DiffFile = {
  /** The path after the change; the old path for a deleted file. */
  path: string;
  /** The path before the change; null for an added file. */
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  /** The added lines, without their `+`. */
  added: string[];
  /** The removed lines, without their `-`. */
  removed: string[];
};

const HEADER = /^diff --git a\/(.+) b\/(.+)$/;

/** The files of a unified diff. Context lines and hunk headers are read past. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let inHunk = false;

  for (const line of text.split("\n")) {
    const header = HEADER.exec(line);
    if (header) {
      current = {
        path: header[2],
        oldPath: header[1],
        status: header[1] === header[2] ? "modified" : "renamed",
        binary: false,
        added: [],
        removed: [],
      };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;

    if (!inHunk) {
      if (line.startsWith("new file mode")) {
        current.status = "added";
        current.oldPath = null;
      } else if (line.startsWith("deleted file mode")) {
        current.status = "deleted";
      } else if (line.startsWith("rename from ")) {
        current.oldPath = line.slice("rename from ".length);
        current.status = "renamed";
      } else if (line.startsWith("rename to ")) {
        current.path = line.slice("rename to ".length);
      } else if (line.startsWith("Binary files ")) {
        current.binary = true;
      } else if (line.startsWith("@@")) {
        inHunk = true;
      }
      continue;
    }

    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return files;
}
