export type SearchCommand = {
  id: string;
  label: string;
  group: string;
  href: string;
  keywords?: readonly string[];
};

export function searchCommands<T extends SearchCommand>(
  commands: readonly T[],
  query: string,
): T[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [...commands];
  const terms = normalizedQuery.split(/\s+/);
  return commands
    .map((command, index) => ({
      command,
      index,
      score: commandScore(command, terms),
    }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ command }) => command);
}

function commandScore(command: SearchCommand, terms: readonly string[]): number {
  const label = normalize(command.label);
  const group = normalize(command.group);
  const keywords = (command.keywords ?? []).map(normalize);
  return terms.reduce((total, term) => {
    const score = termScore(term, label, group, keywords);
    return Number.isFinite(score) && Number.isFinite(total)
      ? total + score
      : Number.POSITIVE_INFINITY;
  }, 0);
}

function termScore(
  term: string,
  label: string,
  group: string,
  keywords: readonly string[],
): number {
  const labelWords = label.split(/\s+/);
  if (label === term) return 0;
  if (labelWords.includes(term)) return 1;
  if (label.startsWith(term)) return 2;
  if (labelWords.some((word) => word.startsWith(term))) return 3;
  if (label.includes(term)) return 4;
  if (keywords.some((keyword) => keyword === term)) return 5;
  if (keywords.some((keyword) => keyword.startsWith(term))) return 6;
  if (keywords.some((keyword) => keyword.includes(term))) return 7;
  if (group.includes(term)) return 8;
  return Number.POSITIVE_INFINITY;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}
