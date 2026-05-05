export function pickDecoys(
  activeNames: string[],
  categories: Record<string, string[]>,
  minTotal: number,
): string[] {
  const needed = minTotal - activeNames.length;
  if (needed <= 0) return [];

  const activeSet = new Set(activeNames);

  // Find categories occupied by any active tool
  const occupiedCategories = new Set<string>();
  for (const [cat, tools] of Object.entries(categories)) {
    if (tools.some((t) => activeSet.has(t))) {
      occupiedCategories.add(cat);
    }
  }

  // Collect pool from unoccupied categories (sorted for determinism)
  const pool: string[] = [];
  for (const cat of Object.keys(categories).sort()) {
    if (occupiedCategories.has(cat)) continue;
    for (const t of [...categories[cat]].sort()) {
      if (!activeSet.has(t)) pool.push(t);
    }
  }

  return pool.slice(0, needed);
}
