import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A small bundled set of public Ratel docs pages, searched by keyword. Read-only.

export interface DocPage {
  readonly slug: string;
  readonly title: string;
  readonly body: string;
}

export interface SearchHit {
  readonly slug: string;
  readonly title: string;
  readonly snippet: string;
}

const DOCS_DIR = fileURLToPath(new URL("./docs/", import.meta.url));

export const pages: readonly DocPage[] = readdirSync(DOCS_DIR)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((file) => {
    const body = readFileSync(`${DOCS_DIR}${file}`, "utf8");
    const title = body.match(/^# (.+)$/m)?.[1] ?? file;
    return { slug: file.replace(/\.md$/, ""), title, body };
  });

/** The pages that match the most query words, best first. */
export function searchDocs(query: string, limit = 3): SearchHit[] {
  const words = query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
  return pages
    .map((page) => {
      const text = page.body.toLowerCase();
      const score = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
      return { page, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.page.slug.localeCompare(b.page.slug))
    .slice(0, limit)
    .map(({ page }) => ({ slug: page.slug, title: page.title, snippet: snippetOf(page.body) }));
}

export function readDoc(slug: string): DocPage | undefined {
  return pages.find((p) => p.slug === slug);
}

function snippetOf(body: string): string {
  const text = body.replace(/^# .+$/m, "").replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}
