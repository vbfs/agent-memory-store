/**
 * Hybrid search engine combining FTS5 BM25 (native SQLite) and vector similarity.
 *
 * Search modes:
 *   - "hybrid"   — FTS5 BM25 + vector cosine similarity merged via Reciprocal Rank Fusion
 *   - "bm25"     — FTS5 only (no embeddings needed)
 *   - "semantic"  — Vector similarity only
 *
 * Falls back to BM25-only if embeddings are not available.
 */

import { searchFTS, getAllEmbeddings, getChunk } from "./db.js";
import { embed, isEmbeddingAvailable } from "./embeddings.js";

// ─── Vector Search ──────────────────────────────────────────────────────────

/**
 * Computes cosine similarity between two Float32Arrays.
 * Assumes both vectors are already L2-normalized (dot product = cosine sim).
 */
function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Brute-force vector search over all chunk embeddings.
 */
function vectorSearch(queryEmbedding, { agent, tags = [], topK = 18 }) {
  const embeddings = getAllEmbeddings({ agent, tags });
  if (!embeddings.length) return [];

  return embeddings
    .map(({ id, embedding }) => ({
      id,
      score: cosineSimilarity(queryEmbedding, embedding),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ─── Fusion ─────────────────────────────────────────────────────────────────

/**
 * Reciprocal Rank Fusion — merges two ranked lists into one.
 */
function reciprocalRankFusion(bm25Hits, vecHits, wBM25 = 0.4, wVec = 0.6) {
  const K = 60;
  const scores = new Map();

  bm25Hits.forEach(({ id }, rank) => {
    scores.set(id, (scores.get(id) || 0) + wBM25 / (K + rank + 1));
  });

  vecHits.forEach(({ id }, rank) => {
    scores.set(id, (scores.get(id) || 0) + wVec / (K + rank + 1));
  });

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// ─── Main Search ────────────────────────────────────────────────────────────

/**
 * Main search function — performs hybrid, BM25, or semantic search.
 *
 * @param {object} opts
 * @param {string}   opts.query
 * @param {string[]} [opts.tags]
 * @param {string}   [opts.agent]
 * @param {number}   [opts.topK]
 * @param {number}   [opts.minScore]
 * @param {string}   [opts.mode]  - "hybrid" | "bm25" | "semantic"
 * @returns {Promise<Array>}
 */
export async function hybridSearch({
  query,
  tags = [],
  agent,
  topK = 6,
  minScore = 0.1,
  mode = "hybrid",
}) {
  const candidateK = topK * 3;
  const embeddingsReady = isEmbeddingAvailable();

  // Determine effective mode
  let effectiveMode = mode;
  if ((mode === "hybrid" || mode === "semantic") && !embeddingsReady) {
    effectiveMode = "bm25";
  }

  let fusedResults;

  if (effectiveMode === "bm25") {
    fusedResults = searchFTS({ query, agent, tags, topK: candidateK });
  } else if (effectiveMode === "semantic") {
    const queryEmbedding = await embed(query);
    if (!queryEmbedding) {
      fusedResults = searchFTS({ query, agent, tags, topK: candidateK });
    } else {
      fusedResults = vectorSearch(queryEmbedding, {
        agent,
        tags,
        topK: candidateK,
      });
    }
  } else {
    // Hybrid: run FTS5 (sync) and embed query (async) in parallel
    const queryEmbeddingPromise = embed(query);
    const bm25Hits = searchFTS({ query, agent, tags, topK: candidateK });
    const queryEmbedding = await queryEmbeddingPromise;

    if (!queryEmbedding) {
      fusedResults = bm25Hits;
    } else {
      const vecHits = vectorSearch(queryEmbedding, {
        agent,
        tags,
        topK: candidateK,
      });
      fusedResults = reciprocalRankFusion(bm25Hits, vecHits);
    }
  }

  // Take topK and enrich with full chunk data
  const topResults = fusedResults.slice(0, topK);
  const enriched = [];

  for (const { id, score } of topResults) {
    const chunk = getChunk(id);
    if (!chunk) continue;

    enriched.push({
      id: chunk.id,
      topic: chunk.topic,
      agent: chunk.agent,
      tags: chunk.tags,
      importance: chunk.importance,
      score: Math.round(score * 100) / 100,
      content: chunk.content,
      updated: chunk.updatedAt,
    });
  }

  return enriched;
}
