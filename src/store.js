/**
 * context-store: SQLite-backed persistent memory for multi-agent systems.
 *
 * Storage: single SQLite database at <STORE_PATH>/store.db
 * Search: hybrid (BM25 via FTS5 + vector cosine similarity + RRF)
 * Embeddings: local via @huggingface/transformers (graceful fallback to BM25-only)
 */

import { createHash } from "crypto";
import {
  getDb,
  insertChunk,
  getChunk,
  deleteChunkById,
  listChunksDb,
  getStateDb,
  setStateDb,
  updateEmbedding,
  getChunksWithoutEmbedding,
} from "./db.js";
import { hybridSearch } from "./search.js";
import { embed, prepareText, warmup } from "./embeddings.js";
import { migrateIfNeeded } from "./migrate.js";

/**
 * Initializes the store: runs migration if needed, warms up DB and embeddings.
 * Called once at startup.
 */
export async function initStore() {
  // Ensure DB is ready (also runs schema + expiry purge)
  getDb();

  // Migrate from filesystem if needed
  await migrateIfNeeded();

  // Warm up embedding model in background (non-blocking)
  warmup().then(() => backfillEmbeddings());
}

/**
 * Background task: computes embeddings for chunks that don't have one yet.
 */
async function backfillEmbeddings() {
  const chunks = getChunksWithoutEmbedding();
  if (!chunks.length) return;

  process.stderr.write(
    `[agent-memory-store] Backfilling embeddings for ${chunks.length} chunks...\n`,
  );

  for (const chunk of chunks) {
    const text = prepareText({
      topic: chunk.topic,
      tags: chunk.tags,
      content: chunk.content,
    });
    const embedding = await embed(text);
    if (embedding) {
      updateEmbedding(chunk.id, embedding);
    }
  }

  process.stderr.write(
    `[agent-memory-store] Embedding backfill complete.\n`,
  );
}

/**
 * Generates a stable short ID from agent + topic + current timestamp.
 * @param {string} agentId
 * @param {string} topic
 * @returns {string} 10-char hex string
 */
function generateId(agentId, topic) {
  const seed = `${agentId}:${topic}:${Date.now()}:${Math.random()}`;
  return createHash("sha1").update(seed).digest("hex").slice(0, 10);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Searches chunks using hybrid search (BM25 + vector + RRF).
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
export async function searchChunks({
  query,
  tags = [],
  agent,
  topK = 6,
  minScore = 0.1,
  mode = "hybrid",
}) {
  return hybridSearch({ query, tags, agent, topK, minScore, mode });
}

/**
 * Writes a new chunk to the database.
 * Embedding is computed asynchronously in the background.
 *
 * @param {object} opts
 * @param {string}   opts.topic
 * @param {string}   opts.content
 * @param {string}   [opts.agent]
 * @param {string[]} [opts.tags]
 * @param {string}   [opts.importance]
 * @param {number}   [opts.ttlDays]
 * @returns {Promise<{ id, topic, tags, importance }>}
 */
export async function writeChunk({
  topic,
  content,
  agent = "global",
  tags = [],
  importance = "medium",
  ttlDays = null,
}) {
  const id = generateId(agent, topic);
  const now = new Date().toISOString();
  const expiresAt = ttlDays
    ? new Date(Date.now() + ttlDays * 86_400_000).toISOString()
    : null;

  insertChunk({
    id,
    topic,
    agent,
    tags,
    importance,
    content,
    embedding: null, // Computed in background
    createdAt: now,
    updatedAt: now,
    expiresAt,
  });

  // Compute embedding in background (non-blocking)
  const text = prepareText({ topic, tags, content });
  embed(text).then((embedding) => {
    if (embedding) updateEmbedding(id, embedding);
  });

  return { id, topic, tags, importance };
}

/**
 * Reads a single chunk by its ID.
 *
 * @param {string} id
 * @returns {Promise<{ meta: object, content: string } | null>}
 */
export async function readChunk(id) {
  const chunk = getChunk(id);
  if (!chunk) return null;

  return {
    meta: {
      id: chunk.id,
      topic: chunk.topic,
      agent: chunk.agent,
      tags: chunk.tags,
      importance: chunk.importance,
      updated: chunk.updatedAt,
      ...(chunk.expiresAt ? { expires: chunk.expiresAt } : {}),
    },
    content: chunk.content,
  };
}

/**
 * Deletes a chunk by ID.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteChunk(id) {
  return deleteChunkById(id);
}

/**
 * Lists chunk metadata without loading full content.
 * Sorted by most recently updated.
 *
 * @param {object}   opts
 * @param {string}   [opts.agent]
 * @param {string[]} [opts.tags]
 * @returns {Promise<Array>}
 */
export async function listChunks({ agent, tags = [], limit = 100, offset = 0 } = {}) {
  return listChunksDb({ agent, tags, limit, offset });
}

/**
 * Reads a session state variable.
 *
 * @param {string} key
 * @returns {Promise<any | null>}
 */
export async function getState(key) {
  return getStateDb(key);
}

/**
 * Writes a session state variable.
 *
 * @param {string} key
 * @param {any}    value
 * @returns {Promise<{ key: string, updated: string }>}
 */
export async function setState(key, value) {
  return setStateDb(key, value);
}
