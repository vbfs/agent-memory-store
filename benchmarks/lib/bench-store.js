/**
 * BenchStore — in-memory SQLite store for benchmark isolation.
 *
 * Replicates the same schema, FTS5, and hybrid search logic from
 * src/db.js and src/search.js, but uses DatabaseSync(":memory:")
 * so each question gets a fresh, isolated database with zero disk I/O.
 */

import { DatabaseSync } from "node:sqlite";

// ─── Schema (mirrored from src/db.js) ───────────────────────────────────────

const SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS chunks (
  id         TEXT PRIMARY KEY,
  topic      TEXT NOT NULL,
  agent      TEXT NOT NULL DEFAULT 'global',
  tags       TEXT NOT NULL DEFAULT '[]',
  importance TEXT NOT NULL DEFAULT 'medium',
  content    TEXT NOT NULL,
  embedding  BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);
`;

const SCHEMA_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  id UNINDEXED,
  topic,
  tags,
  agent,
  content,
  content='chunks',
  content_rowid=rowid
);
`;

const SCHEMA_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, id, topic, tags, agent, content)
  VALUES (new.rowid, new.id, new.topic, new.tags, new.agent, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, id, topic, tags, agent, content)
  VALUES ('delete', old.rowid, old.id, old.topic, old.tags, old.agent, old.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, id, topic, tags, agent, content)
  VALUES ('delete', old.rowid, old.id, old.topic, old.tags, old.agent, old.content);
  INSERT INTO chunks_fts(rowid, id, topic, tags, agent, content)
  VALUES (new.rowid, new.id, new.topic, new.tags, new.agent, new.content);
END;
`;

// ─── Search helpers (mirrored from src/search.js) ───────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

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

// ─── BenchStore class ───────────────────────────────────────────────────────

export class BenchStore {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA_TABLES);
    this.db.exec(SCHEMA_FTS);
    this.db.exec(SCHEMA_TRIGGERS);
    this._stmtCache = new Map();
  }

  _stmt(sql) {
    let s = this._stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmtCache.set(sql, s);
    }
    return s;
  }

  /**
   * Insert a chunk with pre-computed embedding.
   */
  insertChunk({ id, topic = "session", agent = "longmemeval", tags = [], importance = "medium", content, embedding }) {
    const now = new Date().toISOString();
    this._stmt(
      `INSERT OR REPLACE INTO chunks (id, topic, agent, tags, importance, content, embedding, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      topic,
      agent,
      JSON.stringify(tags),
      importance,
      content,
      embedding ? Buffer.from(embedding.buffer) : null,
      now,
      now,
      null,
    );
  }

  /**
   * FTS5 BM25 search (mirrors src/db.js searchFTS).
   */
  searchFTS(query, topK = 18) {
    // Strip all non-alphanumeric chars to avoid FTS5 syntax errors
    const ftsQuery = query
      .replace(/[^a-zA-Z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .join(" OR ");

    if (!ftsQuery) return [];

    const sql = `
      SELECT c.id, c.topic, c.content, rank
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.id
      WHERE chunks_fts MATCH ?
      ORDER BY rank LIMIT ?`;

    const rows = this.db.prepare(sql).all(ftsQuery, topK);
    return rows.map((r) => ({
      id: r.id,
      score: -r.rank,
    }));
  }

  /**
   * Vector search over all stored embeddings.
   */
  vectorSearch(queryEmbedding, topK = 18) {
    const rows = this.db
      .prepare(`SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL`)
      .all();

    if (!rows.length) return [];

    return rows
      .map((r) => ({
        id: r.id,
        score: cosineSimilarity(
          queryEmbedding,
          new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
        ),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Hybrid search: BM25 + vector + RRF, or single mode.
   *
   * @param {string} query - Search query text
   * @param {Float32Array|null} queryEmbedding - Pre-computed query embedding
   * @param {number} topK - Number of results
   * @param {string} mode - "hybrid" | "bm25" | "semantic"
   * @returns {Array<{id: string, score: number}>}
   */
  hybridSearch(query, queryEmbedding, topK = 10, mode = "hybrid") {
    const candidateK = topK * 3;

    if (mode === "bm25") {
      return this.searchFTS(query, candidateK).slice(0, topK);
    }

    if (mode === "semantic") {
      if (!queryEmbedding) return this.searchFTS(query, candidateK).slice(0, topK);
      return this.vectorSearch(queryEmbedding, topK);
    }

    // Hybrid
    const bm25Hits = this.searchFTS(query, candidateK);
    if (!queryEmbedding) return bm25Hits.slice(0, topK);

    const vecHits = this.vectorSearch(queryEmbedding, candidateK);
    return reciprocalRankFusion(bm25Hits, vecHits).slice(0, topK);
  }

  /**
   * Close the in-memory database.
   */
  destroy() {
    this._stmtCache.clear();
    this.db.close();
  }
}
