/**
 * Retrieval metrics, ported 1:1 from LongMemEval's official evaluation
 * (src/retrieval/eval_utils.py in github.com/xiaowu0162/LongMemEval):
 *
 *   recall_any@k — 1 if ANY gold doc is in the top k, else 0
 *   recall_all@k — 1 if ALL gold docs are in the top k, else 0
 *   ndcg_any@k   — binary-relevance NDCG over the top k
 *
 * Plus MRR for the golden set.
 */

function dcg(relevances, k) {
  const rel = relevances.slice(0, k);
  if (rel.length === 0) return 0;
  let s = rel[0];
  for (let i = 1; i < rel.length; i++) s += rel[i] / Math.log2(i + 1);
  return s;
}

/**
 * @param {string[]} ranked - retrieved doc ids, best first
 * @param {Set<string>} gold - relevant doc ids
 * @param {number} corpusGold - number of relevant docs in the corpus (for the ideal ranking)
 * @param {number} k
 */
export function ndcgAny(ranked, gold, corpusGold, k) {
  const actual = dcg(ranked.map((id) => (gold.has(id) ? 1 : 0)), k);
  const ideal = dcg(Array.from({ length: corpusGold }, () => 1), k);
  return ideal === 0 ? 0 : actual / ideal;
}

export function recallAny(ranked, gold, k) {
  const top = new Set(ranked.slice(0, k));
  return [...gold].some((id) => top.has(id)) ? 1 : 0;
}

export function recallAll(ranked, gold, k) {
  const top = new Set(ranked.slice(0, k));
  return [...gold].every((id) => top.has(id)) ? 1 : 0;
}

/** Reciprocal rank of the first relevant result (0 if none). */
export function reciprocalRank(ranked, gold) {
  const i = ranked.findIndex((id) => gold.has(id));
  return i === -1 ? 0 : 1 / (i + 1);
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Nearest-rank percentile of a numeric array. */
export function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
