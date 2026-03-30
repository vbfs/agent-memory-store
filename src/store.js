/**
 * context-store: file-based persistent memory for multi-agent systems.
 *
 * Storage layout:
 *   <CONTEXT_STORE_PATH>/
 *     chunks/   → one .md file per chunk, YAML frontmatter + markdown body
 *     state/    → one .json file per key (session state / pipeline variables)
 *
 * Chunk file format:
 *   ---
 *   id: <sha1-10>
 *   topic: "Descriptive title of the chunk"
 *   agent: agent-id
 *   tags: [tag1, tag2]
 *   importance: low | medium | high | critical
 *   updated: ISO-8601
 *   expires: ISO-8601   # optional — omit for permanent chunks
 *   ---
 *   Markdown content here.
 */

import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";
import { createHash } from "crypto";
import { BM25 } from "./bm25.js";

const STORE_PATH = process.env.CONTEXT_STORE_PATH
  ? path.resolve(process.env.CONTEXT_STORE_PATH)
  : path.join(process.cwd(), ".context");

const CHUNKS_DIR = path.join(STORE_PATH, "chunks");
const STATE_DIR = path.join(STORE_PATH, "state");

/** Ensures storage directories exist. */
async function ensureDirs() {
  await fs.mkdir(CHUNKS_DIR, { recursive: true });
  await fs.mkdir(STATE_DIR, { recursive: true });
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

/**
 * Reads all non-expired chunks from disk.
 * Expired chunks are automatically deleted on read.
 *
 * @returns {Promise<Array<{ file: string, meta: object, content: string }>>}
 */
async function loadAllChunks() {
  await ensureDirs();
  const files = await fs.readdir(CHUNKS_DIR).catch(() => []);
  const chunks = [];

  await Promise.all(
    files.map(async (file) => {
      if (!file.endsWith(".md")) return;
      try {
        const raw = await fs.readFile(path.join(CHUNKS_DIR, file), "utf8");
        const { data: meta, content } = matter(raw);

        if (meta.expires && new Date(meta.expires) < new Date()) {
          await fs.unlink(path.join(CHUNKS_DIR, file)).catch(() => {});
          return;
        }

        chunks.push({ file, meta, content: content.trim() });
      } catch {
        // Skip unreadable files silently
      }
    }),
  );

  return chunks;
}

/**
 * Builds a BM25 index from a list of chunks.
 * Searchable text = topic + tags + agent + body content.
 *
 * @param {Array} chunks
 * @returns {BM25}
 */
function buildIndex(chunks) {
  const engine = new BM25();
  for (const c of chunks) {
    const searchText = [
      c.meta.topic || "",
      (c.meta.tags || []).join(" "),
      c.meta.agent || "",
      c.content,
    ].join(" ");
    engine.addDocument(c.file, searchText, c.meta);
  }
  return engine;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Searches chunks by relevance using BM25, with optional tag and agent filters.
 *
 * @param {object} opts
 * @param {string}   opts.query     - Search query text
 * @param {string[]} [opts.tags]    - Filter: only chunks matching any of these tags
 * @param {string}   [opts.agent]   - Filter: only chunks written by this agent
 * @param {number}   [opts.topK]    - Max results (default: 6)
 * @param {number}   [opts.minScore] - Minimum BM25 score threshold (default: 0.1)
 * @returns {Promise<Array>}
 */
export async function searchChunks({
  query,
  tags = [],
  agent,
  topK = 6,
  minScore = 0.1,
}) {
  const chunks = await loadAllChunks();
  if (chunks.length === 0) return [];

  const engine = buildIndex(chunks);
  const hasFilter = tags.length > 0 || !!agent;

  const filter = hasFilter
    ? (meta) => {
        if (agent && meta.agent !== agent) return false;
        if (tags.length > 0 && !tags.some((t) => (meta.tags || []).includes(t)))
          return false;
        return true;
      }
    : null;

  const hits = engine.search(query, topK, filter);
  const byFile = Object.fromEntries(chunks.map((c) => [c.file, c]));

  return hits
    .filter((h) => h.score >= minScore)
    .map((h) => {
      const c = byFile[h.id];
      return {
        id: c.meta.id,
        topic: c.meta.topic,
        agent: c.meta.agent,
        tags: c.meta.tags || [],
        importance: c.meta.importance || "medium",
        score: Math.round(h.score * 100) / 100,
        content: c.content,
        updated: c.meta.updated,
      };
    });
}

/**
 * Writes a new chunk to disk.
 *
 * @param {object} opts
 * @param {string}   opts.topic      - Short descriptive title
 * @param {string}   opts.content    - Markdown body content
 * @param {string}   [opts.agent]    - Agent identifier
 * @param {string[]} [opts.tags]     - Search tags
 * @param {string}   [opts.importance] - low | medium | high | critical
 * @param {number}   [opts.ttlDays]  - Days until auto-expiry (omit = permanent)
 * @returns {Promise<{ id, file, topic, tags, importance }>}
 */
export async function writeChunk({
  topic,
  content,
  agent = "global",
  tags = [],
  importance = "medium",
  ttlDays = null,
}) {
  await ensureDirs();

  const id = generateId(agent, topic);
  const now = new Date().toISOString();
  const expires = ttlDays
    ? new Date(Date.now() + ttlDays * 86_400_000).toISOString()
    : null;

  const meta = {
    id,
    topic,
    agent,
    tags,
    importance,
    updated: now,
    ...(expires ? { expires } : {}),
  };

  const fileContent = matter.stringify(`\n${content}\n`, meta);
  const filename = `${id}.md`;

  await fs.writeFile(path.join(CHUNKS_DIR, filename), fileContent, "utf8");
  return { id, file: filename, topic, tags, importance };
}

/**
 * Reads a single chunk by its ID.
 *
 * @param {string} id
 * @returns {Promise<{ meta: object, content: string } | null>}
 */
export async function readChunk(id) {
  const chunks = await loadAllChunks();
  return chunks.find((c) => c.meta.id === id) ?? null;
}

/**
 * Deletes a chunk by ID.
 *
 * @param {string} id
 * @returns {Promise<boolean>} true if deleted, false if not found
 */
export async function deleteChunk(id) {
  const chunks = await loadAllChunks();
  const target = chunks.find((c) => c.meta.id === id);
  if (!target) return false;
  await fs.unlink(path.join(CHUNKS_DIR, target.file));
  return true;
}

/**
 * Lists chunk metadata without loading full content.
 * Results are sorted by most recently updated.
 *
 * @param {object}   opts
 * @param {string}   [opts.agent]
 * @param {string[]} [opts.tags]
 * @returns {Promise<Array>}
 */
export async function listChunks({ agent, tags = [] } = {}) {
  const chunks = await loadAllChunks();
  return chunks
    .filter((c) => {
      if (agent && c.meta.agent !== agent) return false;
      if (tags.length > 0 && !tags.some((t) => (c.meta.tags || []).includes(t)))
        return false;
      return true;
    })
    .map((c) => ({
      id: c.meta.id,
      topic: c.meta.topic,
      agent: c.meta.agent,
      tags: c.meta.tags || [],
      importance: c.meta.importance || "medium",
      updated: c.meta.updated,
    }))
    .sort((a, b) => new Date(b.updated) - new Date(a.updated));
}

/**
 * Reads a session state variable.
 *
 * @param {string} key
 * @returns {Promise<any | null>}
 */
export async function getState(key) {
  await ensureDirs();
  try {
    const raw = await fs.readFile(path.join(STATE_DIR, `${key}.json`), "utf8");
    return JSON.parse(raw).value;
  } catch {
    return null;
  }
}

/**
 * Writes a session state variable (any JSON-serializable value).
 *
 * @param {string} key
 * @param {any}    value
 * @returns {Promise<{ key: string, updated: string }>}
 */
export async function setState(key, value) {
  await ensureDirs();
  const updated = new Date().toISOString();
  await fs.writeFile(
    path.join(STATE_DIR, `${key}.json`),
    JSON.stringify({ key, value, updated }, null, 2),
    "utf8",
  );
  return { key, updated };
}
