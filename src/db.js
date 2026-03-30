/**
 * SQLite database layer powered by sql.js (WASM).
 *
 * Single-file database at <STORE_PATH>/store.db.
 * BLOB columns for vector embeddings, indexed lookups for CRUD.
 * BM25 search is handled in-memory by bm25.js (sql.js WASM doesn't include FTS5).
 * Debounced flush to disk after mutations (500ms).
 */

import initSqlJs from "sql.js";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

const STORE_PATH = process.env.AGENT_STORE_PATH
  ? path.resolve(process.env.AGENT_STORE_PATH)
  : path.join(process.cwd(), ".agent-memory-store");

const DB_PATH = path.join(STORE_PATH, "store.db");

let db = null;
let flushTimer = null;

const SCHEMA = `
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

CREATE INDEX IF NOT EXISTS idx_chunks_agent   ON chunks(agent);
CREATE INDEX IF NOT EXISTS idx_chunks_updated ON chunks(updated_at);
CREATE INDEX IF NOT EXISTS idx_chunks_expires ON chunks(expires_at);

CREATE TABLE IF NOT EXISTS state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Ensures the store directory exists. */
async function ensureDir() {
  await fs.mkdir(STORE_PATH, { recursive: true });
}

/**
 * Initializes (or returns cached) the sql.js database.
 * Loads existing store.db from disk if present, otherwise creates a new one.
 */
export async function getDb() {
  if (db) return db;

  await ensureDir();

  const SQL = await initSqlJs();

  try {
    const buffer = await fs.readFile(DB_PATH);
    db = new SQL.Database(buffer);
  } catch {
    db = new SQL.Database();
  }

  // Run schema (IF NOT EXISTS makes this idempotent)
  const statements = SCHEMA.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    db.run(stmt);
  }

  // Purge expired chunks
  db.run(
    `DELETE FROM chunks WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`,
  );

  // Flush after initial cleanup
  scheduleFlush();

  // Graceful shutdown
  const shutdown = () => {
    flushSync();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return db;
}

/** Debounced flush — schedules a write to disk 500ms after the last mutation. */
function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flushAsync(), 500);
}

/** Synchronous flush for shutdown. */
function flushSync() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fsSync.writeFileSync(DB_PATH + ".tmp", buffer);
    fsSync.renameSync(DB_PATH + ".tmp", DB_PATH);
  } catch {
    // Best-effort on shutdown
  }
}

/** Async flush — atomic write via temp file + rename. */
async function flushAsync() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  await fs.writeFile(DB_PATH + ".tmp", buffer);
  await fs.rename(DB_PATH + ".tmp", DB_PATH);
}

// ─── CRUD Operations ────────────────────────────────────────────────────────

/**
 * Inserts or replaces a chunk in the database.
 */
export async function insertChunk({
  id,
  topic,
  agent,
  tags,
  importance,
  content,
  embedding,
  createdAt,
  updatedAt,
  expiresAt,
}) {
  const d = await getDb();
  d.run(
    `INSERT OR REPLACE INTO chunks (id, topic, agent, tags, importance, content, embedding, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      topic,
      agent,
      JSON.stringify(tags),
      importance,
      content,
      embedding ? Buffer.from(embedding.buffer) : null,
      createdAt,
      updatedAt,
      expiresAt,
    ],
  );
  scheduleFlush();
}

/**
 * Retrieves a single chunk by ID.
 * @returns {object|null}
 */
export async function getChunk(id) {
  const d = await getDb();
  const rows = d.exec(`SELECT * FROM chunks WHERE id = ?`, [id]);
  if (!rows.length || !rows[0].values.length) return null;
  return rowToChunk(rows[0].columns, rows[0].values[0]);
}

/**
 * Deletes a chunk by ID.
 * @returns {boolean} true if a row was deleted
 */
export async function deleteChunkById(id) {
  const d = await getDb();
  d.run(`DELETE FROM chunks WHERE id = ?`, [id]);
  const changes = d.getRowsModified();
  if (changes > 0) scheduleFlush();
  return changes > 0;
}

/**
 * Lists chunk metadata, with optional agent/tags filters.
 * Sorted by updated_at descending.
 */
export async function listChunksDb({ agent, tags = [] } = {}) {
  const d = await getDb();
  let sql = `SELECT id, topic, agent, tags, importance, updated_at FROM chunks`;
  const conditions = [];
  const params = [];

  if (agent) {
    conditions.push(`agent = ?`);
    params.push(agent);
  }

  if (tags.length > 0) {
    const tagConditions = tags.map(() => `tags LIKE ?`);
    conditions.push(`(${tagConditions.join(" OR ")})`);
    params.push(...tags.map((t) => `%"${t}"%`));
  }

  if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
  sql += ` ORDER BY updated_at DESC`;

  const rows = d.exec(sql, params);
  if (!rows.length) return [];
  return rows[0].values.map((v) => ({
    id: v[0],
    topic: v[1],
    agent: v[2],
    tags: JSON.parse(v[3]),
    importance: v[4],
    updated: v[5],
  }));
}

/**
 * Loads all chunks for BM25 indexing.
 * Returns id, topic, agent, tags, content for each chunk.
 */
export async function getAllChunksForSearch({ agent, tags = [] } = {}) {
  const d = await getDb();
  let sql = `SELECT id, topic, agent, tags, importance, content, updated_at FROM chunks`;
  const conditions = [];
  const params = [];

  if (agent) {
    conditions.push(`agent = ?`);
    params.push(agent);
  }

  if (tags.length > 0) {
    const tagConditions = tags.map(() => `tags LIKE ?`);
    conditions.push(`(${tagConditions.join(" OR ")})`);
    params.push(...tags.map((t) => `%"${t}"%`));
  }

  if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;

  const rows = d.exec(sql, params);
  if (!rows.length) return [];
  return rows[0].values.map((v) => ({
    id: v[0],
    topic: v[1],
    agent: v[2],
    tags: JSON.parse(v[3]),
    importance: v[4],
    content: v[5],
    updated: v[6],
  }));
}

/**
 * Retrieves all embeddings for vector search.
 * @returns {Array<{ id: string, embedding: Float32Array }>}
 */
export async function getAllEmbeddings({ agent, tags = [] } = {}) {
  const d = await getDb();
  let sql = `SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL`;
  const params = [];

  if (agent) {
    sql += ` AND agent = ?`;
    params.push(agent);
  }

  if (tags.length > 0) {
    const tagConditions = tags.map(() => `tags LIKE ?`);
    sql += ` AND (${tagConditions.join(" OR ")})`;
    params.push(...tags.map((t) => `%"${t}"%`));
  }

  const rows = d.exec(sql, params);
  if (!rows.length) return [];

  return rows[0].values
    .filter((v) => v[1] !== null)
    .map((v) => ({
      id: v[0],
      embedding: new Float32Array(
        v[1].buffer.slice(v[1].byteOffset, v[1].byteOffset + v[1].byteLength),
      ),
    }));
}

/**
 * Updates only the embedding for a chunk.
 */
export async function updateEmbedding(id, embedding) {
  const d = await getDb();
  d.run(`UPDATE chunks SET embedding = ? WHERE id = ?`, [
    Buffer.from(embedding.buffer),
    id,
  ]);
  scheduleFlush();
}

/**
 * Returns chunks that have no embedding yet.
 */
export async function getChunksWithoutEmbedding() {
  const d = await getDb();
  const rows = d.exec(
    `SELECT id, topic, tags, content FROM chunks WHERE embedding IS NULL`,
  );
  if (!rows.length) return [];
  return rows[0].values.map((v) => ({
    id: v[0],
    topic: v[1],
    tags: v[2],
    content: v[3],
  }));
}

// ─── State Operations ───────────────────────────────────────────────────────

export async function getStateDb(key) {
  const d = await getDb();
  const rows = d.exec(`SELECT value FROM state WHERE key = ?`, [key]);
  if (!rows.length || !rows[0].values.length) return null;
  return JSON.parse(rows[0].values[0][0]);
}

export async function setStateDb(key, value) {
  const d = await getDb();
  const updatedAt = new Date().toISOString();
  d.run(
    `INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, ?)`,
    [key, JSON.stringify(value), updatedAt],
  );
  scheduleFlush();
  return { key, updated: updatedAt };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function rowToChunk(columns, values) {
  const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
  return {
    id: row.id,
    topic: row.topic,
    agent: row.agent,
    tags: JSON.parse(row.tags),
    importance: row.importance,
    content: row.content,
    embedding: row.embedding
      ? new Float32Array(
          row.embedding.buffer.slice(
            row.embedding.byteOffset,
            row.embedding.byteOffset + row.embedding.byteLength,
          ),
        )
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export { STORE_PATH };
