import {
  maskArguments,
  stem,
  tokenizeForRelevance,
  toolFamily,
} from "@/lib/readings/intent-engine/text";

/**
 * Cluster names, by rules only (no model):
 *   - level 0: the medoid member, the ask that shares the most words with the
 *     rest of its cluster, as the user wrote it;
 *   - level 1: the masked template its children share ("assign this task to {id}");
 *   - level 2 and up: the object they act on ("Task operations"), or the tool
 *     family they run when the wording names none ("Github operations").
 *
 * `terms` are a cluster's distinguishing words: its most frequent terms,
 * weighed by how few other clusters use them (c-TF-IDF), as the SDK's labels are.
 */

/** The member most like the others (summed term-set Jaccard), first on ties. */
export function medoid(members: readonly string[]): string {
  if (members.length <= 2) return members[0] ?? "";
  const sets = members.map((m) => new Set(tokenizeForRelevance(m)));
  let best = 0;
  let bestScore = -1;
  sets.forEach((a, i) => {
    let score = 0;
    sets.forEach((b, j) => {
      if (i === j || a.size === 0 || b.size === 0) return;
      let inter = 0;
      for (const t of a) if (b.has(t)) inter += 1;
      score += inter / (a.size + b.size - inter);
    });
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return members[best];
}

/** Distinct members compared when looking for a group's most central ones. */
const CENTRAL_POOL = 60;

/**
 * The `k` members most like the rest (summed term-set Jaccard, as {@link medoid}),
 * most central first, ties in order. A member that bridges to another group is
 * the least like its own, so it is the last to stand for the group.
 */
export function centralPhrases(members: readonly string[], k: number): string[] {
  // Pairwise, so bounded: the first distinct members a node holds are enough to find its centre.
  const distinct = [...new Set(members)].slice(0, CENTRAL_POOL);
  if (distinct.length <= k) return distinct;
  const sets = distinct.map((m) => new Set(tokenizeForRelevance(m)));
  const weight = new Map<string, number>();
  for (const m of members) weight.set(m, (weight.get(m) ?? 0) + 1);
  const score = sets.map((a, i) => {
    let sum = 0;
    sets.forEach((b, j) => {
      if (i === j || a.size === 0 || b.size === 0) return;
      let inter = 0;
      for (const t of a) if (b.has(t)) inter += 1;
      sum += (inter / (a.size + b.size - inter)) * (weight.get(distinct[j]) ?? 1);
    });
    return sum;
  });
  return distinct
    .map((m, i) => ({ m, i, s: score[i] }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .slice(0, k)
    .map((x) => x.m);
}

/** The template most of `phrases` reduce to once their arguments are masked. */
export function maskedTemplate(phrases: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const p of phrases) {
    const m = maskArguments(p).masked;
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [m, n] of counts) {
    if (n > bestCount) {
      best = m;
      bestCount = n;
    }
  }
  // No template repeats: the medoid of the masked forms names the group best.
  return bestCount > 1 ? best : medoid([...counts.keys()]);
}

/** A stemmed term as the users wrote it most often ("test" -> "tests", "ci" -> "CI"). */
export function displayWord(term: string, phrases: readonly string[]): string {
  const forms = new Map<string, number>();
  for (const p of phrases) {
    for (const raw of p.split(/[^\p{L}\p{N}]+/u)) {
      if (raw.length < 2 || stem(raw.toLowerCase()) !== term) continue;
      forms.set(raw, (forms.get(raw) ?? 0) + 1);
    }
  }
  let best = term;
  let bestCount = 0;
  for (const [form, n] of forms) {
    if (n > bestCount) {
      best = form;
      bestCount = n;
    }
  }
  return best;
}

/** "Task operations", "CI test operations": the object a group acts on. */
export function objectName(
  objectTerms: readonly string[],
  phrases: readonly string[],
  toolIds: readonly string[],
): string {
  if (objectTerms.length > 0) {
    // A second word only when every phrase of the group carries it too.
    const everywhere = (term: string) =>
      phrases.every((p) => tokenizeForRelevance(p).includes(term));
    const chosen =
      objectTerms.length > 1 && everywhere(objectTerms[0]) && everywhere(objectTerms[1])
        ? objectTerms.slice(0, 2)
        : objectTerms.slice(0, 1);
    const words = chosen.map((t) => displayWord(t, phrases));
    const first = words[0];
    words[0] =
      first === first.toLowerCase() ? first.charAt(0).toUpperCase() + first.slice(1) : first;
    return `${words.join(" ")} operations`;
  }
  const families = new Map<string, number>();
  for (const id of toolIds) {
    const f = toolFamily(id);
    if (f) families.set(f, (families.get(f) ?? 0) + 1);
  }
  const top = [...families.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (top) return `${top[0].charAt(0).toUpperCase()}${top[0].slice(1)} operations`;
  return "";
}

/**
 * Top terms per cluster by c-TF-IDF: term frequency within the cluster's
 * members times log(1 + clusters / clusters using the term).
 */
export function distinguishingTerms(
  clusters: ReadonlyArray<readonly string[]>,
  top = 5,
): string[][] {
  const tfs = clusters.map((members) => {
    const tf = new Map<string, number>();
    for (const m of members)
      for (const t of tokenizeForRelevance(m)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
  });
  const df = new Map<string, number>();
  for (const tf of tfs) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = clusters.length;
  return tfs.map((tf) =>
    [...tf.entries()]
      .map(([t, f]) => [t, f * Math.log(1 + n / (df.get(t) ?? 1))] as const)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, top)
      .map(([t]) => t),
  );
}
