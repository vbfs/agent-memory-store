/**
 * Hybrid search engine combining BM25 (in-memory cached) and vector similarity.
 *
 * Search modes:
 *   - "hybrid"   — BM25 + vector cosine similarity merged via Reciprocal Rank Fusion
 *   - "bm25"     — BM25 only (no embeddings needed)
 *   - "semantic"  — Vector similarity only
 *
 * BM25 index is cached in memory and rebuilt only when chunks change (version bump).
 * Falls back to BM25-only if embeddings are not available.
 */

import { getAllChunksForSearch, getAllEmbeddings, getChunk } from "./db.js";
import { BM25 } from "./bm25.js";
import { embed, isEmbeddingAvailable } from "./embeddings.js";

// ─── BM25 Index Cache ───────────────────────────────────────────────────────

let cachedBm25Engine = null;
let cachedBm25Version = 0;
let currentVersion = 0;

/**
 * Invalidates the BM25 cache. Call after any write/delete.
 */
export function invalidateBm25Cache() {
  currentVersion++;
}

/**
 * Returns a BM25 engine, rebuilding only if chunks changed.
 * For filtered queries (agent/tags), we still use the global index
 * but apply filters at search time — avoids rebuilding per filter combo.
 */
async function getBm25Engine() {
  if (cachedBm25Engine && cachedBm25Version === currentVersion) {
    return cachedBm25Engine;
  }

  const chunks = await getAllChunksForSearch();
  const engine = new BM25();

  for (const c of chunks) {
    const searchText = [
      c.topic || "",
      (c.tags || []).join(" "),
      c.agent || "",
      c.content,
    ].join(" ");
    engine.addDocument(c.id, searchText, {
      id: c.id,
      agent: c.agent,
      tags: c.tags,
    });
  }

  cachedBm25Engine = engine;
  cachedBm25Version = currentVersion;
  return engine;
}

/**
 * BM25 search using the cached global index with optional filters.
 */
async function bm25Search({ query, agent, tags = [], topK = 18 }) {
  const engine = await getBm25Engine();
  if (!engine.documents.length) return [];

  const hasFilter = !!agent || tags.length > 0;
  const filter = hasFilter
    ? (meta) => {
        if (agent && meta.agent !== agent) return false;
        if (tags.length > 0 && !tags.some((t) => (meta.tags || []).includes(t)))
          return false;
        return true;
      }
    : null;

  return engine
    .search(query, topK, filter)
    .map(({ id, score }) => ({ id, score }));
}

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
async function vectorSearch(queryEmbedding, { agent, tags = [], topK = 18 }) {
  const embeddings = await getAllEmbeddings({ agent, tags });
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
    const bm25Hits = await bm25Search({ query, agent, tags, topK: candidateK });
    fusedResults = bm25Hits;
  } else if (effectiveMode === "semantic") {
    const queryEmbedding = await embed(query);
    if (!queryEmbedding) {
      fusedResults = await bm25Search({ query, agent, tags, topK: candidateK });
    } else {
      fusedResults = await vectorSearch(queryEmbedding, {
        agent,
        tags,
        topK: candidateK,
      });
    }
  } else {
    // Hybrid: run BM25 and vector in parallel
    const [bm25Hits, queryEmbedding] = await Promise.all([
      bm25Search({ query, agent, tags, topK: candidateK }),
      embed(query),
    ]);

    if (!queryEmbedding) {
      fusedResults = bm25Hits;
    } else {
      const vecHits = await vectorSearch(queryEmbedding, {
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
    if (score < minScore * 0.01) continue;

    const chunk = await getChunk(id);
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
