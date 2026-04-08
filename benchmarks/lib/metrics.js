/**
 * LongMemEval retrieval metrics: Recall@k and NDCG@k.
 */

/**
 * Recall@k — fraction of relevant items found in the top-k retrieved results.
 *
 * @param {string[]} retrievedIds - Ranked list of retrieved IDs
 * @param {Set<string>} relevantIds - Set of ground-truth relevant IDs
 * @param {number} k - Cutoff
 * @returns {number|null} Recall value (0-1), or null if no relevant items exist
 */
export function recallAtK(retrievedIds, relevantIds, k) {
  if (relevantIds.size === 0) return null;
  const topK = retrievedIds.slice(0, k);
  let found = 0;
  for (const id of topK) {
    if (relevantIds.has(id)) found++;
  }
  return found / relevantIds.size;
}

/**
 * NDCG@k — Normalized Discounted Cumulative Gain.
 *
 * @param {string[]} retrievedIds - Ranked list of retrieved IDs
 * @param {Set<string>} relevantIds - Set of ground-truth relevant IDs
 * @param {number} k - Cutoff
 * @returns {number|null} NDCG value (0-1), or null if no relevant items exist
 */
export function ndcgAtK(retrievedIds, relevantIds, k) {
  if (relevantIds.size === 0) return null;

  const topK = retrievedIds.slice(0, k);

  // DCG@k
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    if (relevantIds.has(topK[i])) {
      dcg += 1 / Math.log2(i + 2); // i+2 because log2(1) = 0
    }
  }

  // IDCG@k — ideal ranking: all relevant items first
  const idealCount = Math.min(relevantIds.size, k);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  if (idcg === 0) return 0;
  return dcg / idcg;
}
