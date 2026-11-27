/**
 * The small glob the repository link uses for branches and paths: `**` crosses slashes, `*` and
 * `?` do not. Every other character is literal.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      // `**/` also matches no directory at all: `**/prompts/**` matches `prompts/a.md`.
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** A branch pattern (`main`, `release/*`) against a branch name. */
export function matchesBranch(pattern: string, branch: string): boolean {
  return globToRegExp(pattern).test(branch);
}

/**
 * A path pattern against a repository path, as in `.gitignore`: with no slash it matches the
 * file name at any depth (`Dockerfile`, `*.md`); with one it is anchored at the root.
 */
export function matchesPath(pattern: string, path: string): boolean {
  if (!pattern.includes("/")) {
    return globToRegExp(pattern).test(path.slice(path.lastIndexOf("/") + 1));
  }
  return globToRegExp(pattern).test(path);
}

export function matchesAnyPath(patterns: readonly string[], path: string): string | null {
  return patterns.find((pattern) => matchesPath(pattern, path)) ?? null;
}
