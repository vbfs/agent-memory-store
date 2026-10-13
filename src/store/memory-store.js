/**
 * MemoryStore — the single implementation used by the MCP server, the tests
 * and the benchmarks.
 *
 * Storage: one SQLite file (node:sqlite), WAL mode, safe for several agent
 * processes sharing it. Search: FTS5 BM25 + exact vector similarity fused
 * with Reciprocal Rank Fusion.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "crypto";
import { mkdirSync } from "fs";
import path from "path";
import { buildFtsQuery } from "./fts-query.js";
import { VectorIndex } from "./vector-index.js";
import { findSecret } from "./secrets.js";
import { documentText } from "../embeddings.js";

export const SCHEMA_VERSION = 2;
export const IMPORTANCE = ["low", "medium", "high", "critical"];

const RRF_K = 60;
const PURGE_INTERVAL_MS = 60_000;
const BACKFILL_BATCH = 32;
const LEASE_MS = 120_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * How keyword and semantic rankings are combined.
 *   rrf:    weighted Reciprocal Rank Fusion, w / (60 + rank)
 *   convex: weighted sum of per-query min-max normalized scores
 * semanticWeight is the semantic share (keyword gets 1 - semanticWeight).
 */
export const DEFAULT_FUSION = { method: "convex", semanticWeight: 0.7 };

// Tie-breakers, in units of the normalized 0–1 score. They are smaller than
// the gap between neighbouring results in almost every query, so they only
// reorder results whose relevance is already nearly equal.
const IMPORTANCE_BONUS = { low: 0, medium: 0.001, high: 0.002, critical: 0.003 };
const RECENCY_BONUS = 0.002;
const RECENCY_HALF_LIFE_DAYS = 30;

export class MemoryError extends Error {
  /**
   * @param {"INVALID"|"NOT_FOUND"|"CONFLICT"|"SECRET"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA_V2 = `
CREATE TABLE chunks (
  seq          INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  topic        TEXT NOT NULL,
  content      TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  agent        TEXT NOT NULL DEFAULT 'global',
  updated_by   TEXT,
  importance   TEXT NOT NULL DEFAULT 'medium',
  content_hash TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  expires_at   TEXT
);
CREATE INDEX idx_chunks_agent   ON chunks(agent);
CREATE INDEX idx_chunks_updated ON chunks(updated_at);
CREATE INDEX idx_chunks_expires ON chunks(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_chunks_topic   ON chunks(lower(topic));

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  topic, tags, content,
  content='chunks', content_rowid='seq',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, topic, tags, content)
  VALUES (new.seq, new.topic, new.tags, new.content);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, topic, tags, content)
  VALUES ('delete', old.seq, old.topic, old.tags, old.content);
END;
CREATE TRIGGER chunks_au AFTER UPDATE OF topic, tags, content ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, topic, tags, content)
  VALUES ('delete', old.seq, old.topic, old.tags, old.content);
  INSERT INTO chunks_fts(rowid, topic, tags, content)
  VALUES (new.seq, new.topic, new.tags, new.content);
END;

CREATE TABLE vectors (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id     TEXT NOT NULL UNIQUE REFERENCES chunks(id) ON DELETE CASCADE ON UPDATE CASCADE,
  model        TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vec          BLOB NOT NULL
);
CREATE INDEX idx_vectors_model ON vectors(model, seq);

CREATE TABLE IF NOT EXISTS state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE leases (
  name       TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function hashText(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function toBlob(vec) {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

function fromBlob(blob) {
  // Copy: the blob's buffer may be reused by SQLite bindings.
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

function normalizeTags(tags) {
  if (tags == null) return [];
  if (!Array.isArray(tags)) throw new MemoryError("INVALID", "tags must be an array of strings");
  const out = [];
  for (const t of tags) {
    if (typeof t !== "string") throw new MemoryError("INVALID", "tags must be an array of strings");
    const n = t.trim().toLowerCase();
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function normalizeDate(value, name) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new MemoryError("INVALID", `${name} must be an ISO 8601 date, got "${value}"`);
  }
  return d.toISOString();
}

function rowToMemory(r) {
  return {
    id: r.id,
    topic: r.topic,
    content: r.content,
    tags: JSON.parse(r.tags),
    agent: r.agent,
    updatedBy: r.updated_by ?? r.agent,
    importance: r.importance,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at ?? null,
  };
}

// ─── MemoryStore ────────────────────────────────────────────────────────────

export class MemoryStore {
  /**
   * Opens (and creates or migrates) a store.
   *
   * @param {string} dbPath - path to the SQLite file, or ":memory:"
   * @param {object} [opts]
   * @param {object|null} [opts.embedder] - see src/embeddings.js; null = keyword only
   * @param {() => number} [opts.clock] - ms timestamp source (tests)
   * @param {{ method: "rrf"|"convex", semanticWeight: number }} [opts.fusion]
   * @returns {MemoryStore}
   */
  static open(dbPath, opts = {}) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    return new MemoryStore(new DatabaseSync(dbPath), opts);
  }

  constructor(db, { embedder = null, clock = Date.now, fusion = DEFAULT_FUSION } = {}) {
    this.db = db;
    this.embedder = embedder;
    this.fusion = fusion;
    this.clock = clock;
    this.owner = `${process.pid}:${randomBytes(4).toString("hex")}`;
    this._stmts = new Map();
    this._index = new VectorIndex();
    this._indexModel = null;
    this._indexSeq = 0;
    this._dataVersion = -1;
    this._indexDirty = true;
    this._lastPurge = 0;
    this._drainPromise = null;
    this._closed = false;

    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    this._migrate();
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._stmts.clear();
    this.db.close();
  }

  _stmt(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }

  _now() {
    return new Date(this.clock()).toISOString();
  }

  /** Runs fn inside BEGIN IMMEDIATE (takes the write lock up front, so the busy timeout applies). */
  _tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ─── Schema migrations ──────────────────────────────────────────────────

  _migrate() {
    const version = () => this.db.prepare("PRAGMA user_version").get().user_version;
    if (version() >= SCHEMA_VERSION) return;

    this._tx(() => {
      // Re-check under the write lock: another process may have migrated.
      const v = version();
      if (v >= SCHEMA_VERSION) return;
      const hasLegacy = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chunks'")
        .get();

      if (v === 0 && hasLegacy) this._migrateV1toV2();
      else this.db.exec(SCHEMA_V2);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  /**
   * v1 (<= 0.0.9): chunks with inline embedding, FTS without diacritic
   * folding, state without version. Content is preserved; embeddings are
   * dropped and recomputed by the backfill with the current model.
   */
  _migrateV1toV2() {
    const d = this.db;
    d.exec(`
      DROP TRIGGER IF EXISTS chunks_ai;
      DROP TRIGGER IF EXISTS chunks_ad;
      DROP TRIGGER IF EXISTS chunks_au;
      DROP TABLE IF EXISTS chunks_fts;
      ALTER TABLE chunks RENAME TO chunks_v1;
    `);
    const hasState = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='state'").get();
    if (hasState) d.exec("ALTER TABLE state RENAME TO state_v1");
    d.exec("DROP INDEX IF EXISTS idx_chunks_agent; DROP INDEX IF EXISTS idx_chunks_updated; DROP INDEX IF EXISTS idx_chunks_expires;");
    d.exec(SCHEMA_V2);

    const insert = d.prepare(`
      INSERT INTO chunks (id, topic, content, tags, agent, importance, content_hash, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of d.prepare("SELECT * FROM chunks_v1").iterate()) {
      let tags;
      try {
        tags = normalizeTags(JSON.parse(r.tags));
      } catch {
        tags = [];
      }
      const importance = IMPORTANCE.includes(r.importance) ? r.importance : "medium";
      const expires = r.expires_at ? normalizeDate(r.expires_at, "expires_at") : null;
      insert.run(
        r.id,
        r.topic,
        r.content,
        JSON.stringify(tags),
        r.agent || "global",
        importance,
        hashText(documentText({ topic: r.topic, tags, content: r.content })),
        r.created_at,
        r.updated_at,
        expires,
      );
    }
    d.exec("DROP TABLE chunks_v1");

    if (hasState) {
      d.exec(`INSERT INTO state (key, value, version, updated_at)
              SELECT key, value, 1, updated_at FROM state_v1`);
      d.exec("DROP TABLE state_v1");
    }
  }

  // ─── Filters ────────────────────────────────────────────────────────────

  /**
   * Builds the WHERE clause shared by search, list and the vector allow-list.
   * Expired chunks are always excluded.
   */
  _filters({ agent, tags, since, until } = {}) {
    const clauses = ["(c.expires_at IS NULL OR c.expires_at > ?)"];
    const params = [this._now()];
    let narrowed = false;
    if (agent) {
      clauses.push("c.agent = ?");
      params.push(agent);
      narrowed = true;
    }
    const t = normalizeTags(tags);
    if (t.length) {
      clauses.push(`EXISTS (SELECT 1 FROM json_each(c.tags) j WHERE j.value IN (${t.map(() => "?").join(",")}))`);
      params.push(...t);
      narrowed = true;
    }
    const s = normalizeDate(since, "since");
    if (s) {
      clauses.push("c.updated_at >= ?");
      params.push(s);
      narrowed = true;
    }
    const u = normalizeDate(until, "until");
    if (u) {
      clauses.push("c.updated_at <= ?");
      params.push(u);
      narrowed = true;
    }
    return { where: clauses.join(" AND "), params, narrowed };
  }

  _maybePurge() {
    const nowMs = this.clock();
    if (nowMs - this._lastPurge < PURGE_INTERVAL_MS) return;
    this._lastPurge = nowMs;
    const res = this._stmt(
      "DELETE FROM chunks WHERE expires_at IS NOT NULL AND expires_at <= ?",
    ).run(this._now());
    if (res.changes > 0) this._indexDirty = true;
  }

  // ─── Write ──────────────────────────────────────────────────────────────

  /**
   * Creates or updates a memory.
   *
   * Without `id` a new memory is created. With `id`, the memory is updated in
   * place (or created with that id if it does not exist). Omitted optional
   * fields keep their current values on update.
   *
   * @param {object} input
   * @param {string} input.topic
   * @param {string} input.content
   * @param {string} [input.id]
   * @param {string} [input.agent]
   * @param {string[]} [input.tags]
   * @param {string} [input.importance]
   * @param {number|null} [input.ttlDays] - null removes an existing expiry
   * @param {number} [input.expectedVersion] - compare-and-set; 0 = must not exist
   * @returns {Promise<object>}
   */
  async write(input) {
    const { id: givenId, topic, content, agent, importance, ttlDays, expectedVersion } = input;
    if (typeof topic !== "string" || !topic.trim()) throw new MemoryError("INVALID", "topic is required");
    if (typeof content !== "string" || !content.trim()) throw new MemoryError("INVALID", "content is required");
    if (givenId != null && !ID_RE.test(givenId)) {
      throw new MemoryError("INVALID", "id must be 1-128 chars of letters, digits, '.', '_', ':' or '-'");
    }
    if (importance != null && !IMPORTANCE.includes(importance)) {
      throw new MemoryError("INVALID", `importance must be one of ${IMPORTANCE.join(", ")}`);
    }
    if (ttlDays != null && !(ttlDays > 0)) throw new MemoryError("INVALID", "ttl_days must be positive");
    const secret = findSecret(`${topic}\n${content}`);
    if (secret) {
      throw new MemoryError(
        "SECRET",
        `Refused: content looks like it contains a ${secret}. Store where the secret lives (e.g. "in 1Password: Prod/DB" or "env var DATABASE_URL"), never the value.`,
      );
    }

    const tagsInput = input.tags == null ? null : normalizeTags(input.tags);
    const existing = givenId ? this._getRow(givenId) : null;
    const tags = tagsInput ?? (existing ? JSON.parse(existing.tags) : []);
    const text = documentText({ topic: topic.trim(), tags, content });
    const contentHash = hashText(text);

    // Embed outside the transaction (it is the slow part) when the model is ready.
    let vec = null;
    const contentChanged = !existing || existing.content_hash !== contentHash;
    if (this.embedder?.isReady() && contentChanged) {
      try {
        [vec] = await this.embedder.embedDocuments([text]);
      } catch {
        vec = null; // backfill will retry
      }
    }

    const result = this._tx(() => {
      const now = this._now();
      let current = givenId ? this._getRow(givenId) : null;
      if (current?.expires_at && current.expires_at <= now) {
        // An expired memory no longer exists for readers; reuse of its id is a create.
        this._stmt("DELETE FROM chunks WHERE id = ?").run(givenId);
        current = null;
      }
      if (expectedVersion != null) {
        const currentVersion = current ? current.version : 0;
        if (currentVersion !== expectedVersion) {
          throw new MemoryError(
            "CONFLICT",
            `Version conflict on "${givenId}": expected ${expectedVersion}, current is ${currentVersion}. Re-read and retry.`,
          );
        }
      }

      const expiresAt =
        ttlDays === undefined
          ? current?.expires_at ?? null
          : ttlDays === null
            ? null
            : new Date(this.clock() + ttlDays * 86_400_000).toISOString();

      let id = givenId;
      if (current) {
        this._stmt(`
          UPDATE chunks SET topic = ?, content = ?, tags = ?, updated_by = ?, importance = ?,
                 content_hash = ?, version = version + 1, updated_at = ?, expires_at = ?
          WHERE id = ?`).run(
          topic.trim(),
          content,
          JSON.stringify(tags),
          agent ?? current.updated_by ?? current.agent,
          importance ?? current.importance,
          contentHash,
          now,
          expiresAt,
          id,
        );
      } else {
        if (!id) {
          do id = randomBytes(6).toString("hex");
          while (this._getRow(id));
        }
        this._stmt(`
          INSERT INTO chunks (id, topic, content, tags, agent, updated_by, importance, content_hash, created_at, updated_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id,
          topic.trim(),
          content,
          JSON.stringify(tags),
          agent ?? "global",
          agent ?? "global",
          importance ?? "medium",
          contentHash,
          now,
          now,
          expiresAt,
        );
      }
      if (vec) this._putVector(id, contentHash, vec);
      // No vector for the new content yet: drop the old one rather than search with stale meaning.
      else if (contentChanged) this._stmt("DELETE FROM vectors WHERE chunk_id = ?").run(id);
      return { id, created: !current };
    });

    if (vec || contentChanged) this._indexDirty = true;
    if (!vec && contentChanged && this.embedder) this._scheduleDrain();

    const memory = rowToMemory(this._getRow(result.id));
    return {
      ...memory,
      created: result.created,
      duplicates: await this._findDuplicates(memory, vec),
    };
  }

  /**
   * Imports a memory verbatim (used by the legacy filesystem migration).
   */
  importMemory({ id, topic, content, agent = "global", tags = [], importance = "medium", createdAt, updatedAt, expiresAt = null }) {
    const t = normalizeTags(tags);
    const now = this._now();
    this._stmt(`
      INSERT INTO chunks (id, topic, content, tags, agent, updated_by, importance, content_hash, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).run(
      id,
      topic,
      content,
      JSON.stringify(t),
      agent,
      agent,
      IMPORTANCE.includes(importance) ? importance : "medium",
      hashText(documentText({ topic, tags: t, content })),
      createdAt || now,
      updatedAt || createdAt || now,
      expiresAt ? normalizeDate(expiresAt, "expires") : null,
    );
    this._indexDirty = true;
  }

  _putVector(id, contentHash, vec) {
    this._stmt("DELETE FROM vectors WHERE chunk_id = ?").run(id);
    this._stmt(
      "INSERT INTO vectors (chunk_id, model, content_hash, vec) VALUES (?, ?, ?, ?)",
    ).run(id, this.embedder.id, contentHash, toBlob(vec));
  }

  async _findDuplicates(memory, vec) {
    const found = new Map();
    const sameTopic = this._stmt(`
      SELECT id, topic FROM chunks c
      WHERE lower(c.topic) = lower(?) AND c.id != ? AND (c.expires_at IS NULL OR c.expires_at > ?)
      LIMIT 3`).all(memory.topic, memory.id, this._now());
    for (const r of sameTopic) found.set(r.id, { id: r.id, topic: r.topic, reason: "same topic" });

    if (vec && this._refreshIndex()) {
      const threshold = this.embedder.duplicateThreshold ?? 0.9;
      for (const hit of this._index.search(vec, 4)) {
        if (hit.id === memory.id || found.has(hit.id) || hit.score < threshold) continue;
        const r = this._getRow(hit.id);
        if (!r || (r.expires_at && r.expires_at <= this._now())) continue;
        found.set(hit.id, { id: hit.id, topic: r.topic, reason: `similar content (${hit.score.toFixed(2)})` });
      }
    }
    return [...found.values()].slice(0, 3);
  }

  // ─── Embedding backfill ─────────────────────────────────────────────────

  _scheduleDrain() {
    if (this._drainPromise || !this.embedder || this._closed) return this._drainPromise;
    this._drainPromise = this._drain()
      .catch((err) => process.stderr.write(`[agent-memory-store] Embedding backfill error: ${err.message}\n`))
      .finally(() => {
        this._drainPromise = null;
      });
    return this._drainPromise;
  }

  _acquireLease(name) {
    const nowMs = this.clock();
    const res = this._stmt(`
      INSERT INTO leases (name, owner, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      WHERE leases.expires_at < ? OR leases.owner = excluded.owner`).run(name, this.owner, nowMs + LEASE_MS, nowMs);
    return res.changes > 0;
  }

  _releaseLease(name) {
    this._stmt("DELETE FROM leases WHERE name = ? AND owner = ?").run(name, this.owner);
  }

  /** Embeds every chunk whose vector is missing, stale, or from another model. */
  async _drain() {
    if (!(await this.embedder.load())) return;
    if (this._closed || !this._acquireLease("embed")) return;
    try {
      for (;;) {
        if (this._closed) return;
        const rows = this._stmt(`
          SELECT c.id, c.topic, c.tags, c.content, c.content_hash
          FROM chunks c
          LEFT JOIN vectors v ON v.chunk_id = c.id AND v.model = ? AND v.content_hash = c.content_hash
          WHERE v.chunk_id IS NULL
          LIMIT ${BACKFILL_BATCH}`).all(this.embedder.id);
        if (rows.length === 0) return;
        const texts = rows.map((r) => documentText({ topic: r.topic, tags: JSON.parse(r.tags), content: r.content }));
        const vecs = await this.embedder.embedDocuments(texts);
        if (this._closed) return;
        this._tx(() => {
          for (let i = 0; i < rows.length; i++) {
            // Guard: skip if the chunk changed or vanished while we were embedding.
            const cur = this._stmt("SELECT content_hash FROM chunks WHERE id = ?").get(rows[i].id);
            if (cur && cur.content_hash === rows[i].content_hash) {
              this._putVector(rows[i].id, rows[i].content_hash, vecs[i]);
            }
          }
        });
        this._indexDirty = true;
        this._acquireLease("embed"); // renew
      }
    } finally {
      if (!this._closed) this._releaseLease("embed");
    }
  }

  /**
   * Starts loading the embedding model and backfilling missing vectors in
   * the background. Safe to call repeatedly.
   */
  warmup() {
    if (!this.embedder) return Promise.resolve();
    return this._scheduleDrain() ?? Promise.resolve();
  }

  /** Waits until every chunk has a vector for the current model (tests, benchmarks). */
  async flushEmbeddings() {
    if (!this.embedder) return;
    for (;;) {
      await this._scheduleDrain();
      const pending = this._stmt(`
        SELECT count(*) AS n FROM chunks c
        LEFT JOIN vectors v ON v.chunk_id = c.id AND v.model = ? AND v.content_hash = c.content_hash
        WHERE v.chunk_id IS NULL`).get(this.embedder.id).n;
      if (pending === 0 || !this.embedder.isReady()) return;
      // Another process holds the lease; give it a moment.
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ─── Vector index sync ──────────────────────────────────────────────────

  /**
   * Brings the in-memory index up to date with the vectors table. Cheap when
   * nothing changed: PRAGMA data_version only moves on other connections'
   * commits, and our own writes set _indexDirty.
   *
   * @returns {boolean} true if the index is usable
   */
  _refreshIndex() {
    if (!this.embedder?.isReady()) return false;
    const model = this.embedder.id;
    const dv = this._stmt("PRAGMA data_version").get().data_version;
    if (this._indexModel === model && !this._indexDirty && dv === this._dataVersion) return true;

    if (this._indexModel !== model) {
      this._index = new VectorIndex();
      this._indexModel = model;
      this._indexSeq = 0;
    }
    for (const r of this._stmt(
      "SELECT seq, chunk_id, vec FROM vectors WHERE model = ? AND seq > ? ORDER BY seq",
    ).iterate(model, this._indexSeq)) {
      this._index.upsert(r.chunk_id, fromBlob(r.vec));
      this._indexSeq = r.seq;
    }
    const count = this._stmt("SELECT count(*) AS n FROM vectors WHERE model = ?").get(model).n;
    if (count !== this._index.size) {
      const live = new Set(
        this._stmt("SELECT chunk_id FROM vectors WHERE model = ?").all(model).map((r) => r.chunk_id),
      );
      for (const id of [...this._index.ids]) if (!live.has(id)) this._index.remove(id);
    }
    this._dataVersion = dv;
    this._indexDirty = false;
    return true;
  }

  // ─── Read / delete / list ───────────────────────────────────────────────

  _getRow(id) {
    return this._stmt("SELECT * FROM chunks WHERE id = ?").get(id);
  }

  /**
   * @param {string} id
   * @returns {object|null} the memory, or null if missing or expired
   */
  get(id) {
    const r = this._getRow(id);
    if (!r || (r.expires_at && r.expires_at <= this._now())) return null;
    return rowToMemory(r);
  }

  /**
   * @param {string} id
   * @returns {boolean} true if a memory was deleted
   */
  delete(id) {
    const res = this._stmt("DELETE FROM chunks WHERE id = ?").run(id);
    if (res.changes > 0) {
      this._index.remove(id);
      this._indexDirty = true;
    }
    return res.changes > 0;
  }

  /**
   * Lists memories (newest first) without their content.
   * @returns {{ total: number, items: object[] }}
   */
  list({ agent, tags, since, until, limit = 50, offset = 0 } = {}) {
    this._maybePurge();
    const f = this._filters({ agent, tags, since, until });
    const total = this.db.prepare(`SELECT count(*) AS n FROM chunks c WHERE ${f.where}`).get(...f.params).n;
    const rows = this.db
      .prepare(`SELECT * FROM chunks c WHERE ${f.where} ORDER BY c.updated_at DESC, c.seq DESC LIMIT ? OFFSET ?`)
      .all(...f.params, limit, offset);
    return {
      total,
      items: rows.map((r) => {
        const { content, ...meta } = rowToMemory(r);
        return { ...meta, chars: content.length };
      }),
    };
  }

  // ─── Search ─────────────────────────────────────────────────────────────

  /**
   * Hybrid search.
   *
   * score: fused relevance in [0, 1] (see DEFAULT_FUSION), normalized so
   *   1.0 means "top result of every retriever used". It is relative to the
   *   other results of the same query, not an absolute probability.
   * similarity: cosine similarity to the query (absolute, model-specific),
   *   present when the memory was found by semantic search.
   *
   * @returns {Promise<{ mode: string, results: object[] }>}
   */
  async search({ query, tags, agent, since, until, limit = 6, minScore = 0, mode = "hybrid", fusion = this.fusion }) {
    if (typeof query !== "string" || !query.trim()) throw new MemoryError("INVALID", "query is required");
    if (!["hybrid", "bm25", "semantic"].includes(mode)) {
      throw new MemoryError("INVALID", 'mode must be "hybrid", "bm25" or "semantic"');
    }
    this._maybePurge();
    const f = this._filters({ agent, tags, since, until });
    const candidates = Math.max(50, limit * 5);
    const lists = [];

    // Semantic first (async) so we know whether the keyword list stands alone.
    let semantic = null;
    if (mode !== "bm25" && this.embedder) {
      if (this.embedder.isReady()) {
        let qv = null;
        try {
          qv = await this.embedder.embedQuery(query);
        } catch {
          qv = null; // fall back to keyword search
        }
        if (qv && this._refreshIndex()) {
          const allowed = f.narrowed
            ? new Set(this.db.prepare(`SELECT c.id FROM chunks c WHERE ${f.where}`).all(...f.params).map((r) => r.id))
            : null;
          semantic = this._index.search(qv, candidates, allowed).filter((h) => h.score > 0);
        }
      } else {
        this.warmup();
      }
    }
    if (semantic) lists.push({ name: "semantic", hits: semantic });

    if (mode !== "semantic" || !semantic) {
      const match = buildFtsQuery(query);
      if (match) {
        const hits = this.db
          .prepare(`
            SELECT c.id, bm25(chunks_fts, 3.0, 2.0, 1.0) AS rank FROM chunks_fts
            JOIN chunks c ON c.seq = chunks_fts.rowid
            WHERE chunks_fts MATCH ? AND ${f.where}
            ORDER BY rank
            LIMIT ?`)
          .all(match, ...f.params, candidates)
          .map((r) => ({ id: r.id, score: -r.rank }));
        lists.push({ name: "keyword", hits });
      }
    }

    const effectiveMode =
      lists.length === 2 ? "hybrid" : lists[0]?.name === "semantic" ? "semantic" : "bm25";
    if (lists.length === 0) return { mode: effectiveMode, results: [] };

    const fused = this._fuse(lists, fusion);
    const ids = [...fused.keys()];
    const rows = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const r of this.db
        .prepare(`SELECT * FROM chunks c WHERE c.id IN (${chunk.map(() => "?").join(",")}) AND ${f.where}`)
        .all(...chunk, ...f.params)) {
        rows.set(r.id, r);
      }
    }

    const nowMs = this.clock();
    const results = [];
    for (const [id, e] of fused) {
      const r = rows.get(id);
      if (!r) continue;
      const score = e.score;
      if (score < minScore) continue;
      const ageDays = Math.max(0, (nowMs - Date.parse(r.updated_at)) / 86_400_000);
      const rankKey =
        score +
        (IMPORTANCE_BONUS[r.importance] ?? 0) +
        RECENCY_BONUS * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
      results.push({
        ...rowToMemory(r),
        score: Math.round(score * 1000) / 1000,
        similarity: e.similarity == null ? null : Math.round(e.similarity * 1000) / 1000,
        matched: e.matched,
        _rankKey: rankKey,
      });
    }
    results.sort((a, b) => b._rankKey - a._rankKey);
    return {
      mode: effectiveMode,
      results: results.slice(0, limit).map(({ _rankKey, ...r }) => r),
    };
  }

  /**
   * Combines ranked lists into id → { score (0–1), matched, similarity }.
   */
  _fuse(lists, { method, semanticWeight }) {
    const weightOf = (name) => (name === "semantic" ? semanticWeight : 1 - semanticWeight);
    const totalWeight = lists.reduce((s, l) => s + weightOf(l.name), 0) || 1;
    const fused = new Map();
    for (const { name, hits } of lists) {
      const w = weightOf(name) / totalWeight;
      let lo = Infinity;
      let hi = -Infinity;
      for (const h of hits) {
        lo = Math.min(lo, h.score);
        hi = Math.max(hi, h.score);
      }
      hits.forEach((h, rank) => {
        let e = fused.get(h.id);
        if (!e) fused.set(h.id, (e = { score: 0, matched: [], similarity: null }));
        const part =
          method === "convex"
            ? hi > lo ? (h.score - lo) / (hi - lo) : 1
            : (RRF_K + 1) / (RRF_K + rank + 1);
        e.score += w * part;
        e.matched.push(name);
        if (name === "semantic") e.similarity = h.score;
      });
    }
    return fused;
  }

  // ─── State ──────────────────────────────────────────────────────────────

  /**
   * @param {string} key
   * @returns {{ key, value, version, updatedAt, updatedBy } | null}
   */
  getState(key) {
    const r = this._stmt("SELECT * FROM state WHERE key = ?").get(key);
    if (!r) return null;
    return { key: r.key, value: JSON.parse(r.value), version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by };
  }

  /**
   * Sets a state value. With expectedVersion it is a compare-and-set
   * (0 = key must not exist yet), which lets agents coordinate safely.
   */
  setState(key, value, { expectedVersion, agent } = {}) {
    if (typeof key !== "string" || !key.trim()) throw new MemoryError("INVALID", "key is required");
    if (value === undefined) throw new MemoryError("INVALID", "value is required (use null to clear)");
    const json = JSON.stringify(value);
    const secret = findSecret(json);
    if (secret) throw new MemoryError("SECRET", `Refused: value looks like it contains a ${secret}.`);
    return this._tx(() => {
      const cur = this._stmt("SELECT version FROM state WHERE key = ?").get(key);
      const currentVersion = cur ? cur.version : 0;
      if (expectedVersion != null && expectedVersion !== currentVersion) {
        throw new MemoryError(
          "CONFLICT",
          `Version conflict on state "${key}": expected ${expectedVersion}, current is ${currentVersion}. Re-read and retry.`,
        );
      }
      const now = this._now();
      this._stmt(`
        INSERT INTO state (key, value, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = state.version + 1,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by`).run(key, json, now, agent ?? null);
      return { key, version: currentVersion + 1, updatedAt: now };
    });
  }

  /** Counts for diagnostics. */
  stats() {
    const now = this._now();
    const chunks = this._stmt(
      "SELECT count(*) AS n FROM chunks WHERE expires_at IS NULL OR expires_at > ?",
    ).get(now).n;
    const vectors = this.embedder
      ? this._stmt(`SELECT count(*) AS n FROM vectors v JOIN chunks c ON c.id = v.chunk_id
                    WHERE v.model = ? AND v.content_hash = c.content_hash`).get(this.embedder.id).n
      : 0;
    return { memories: chunks, embedded: vectors, model: this.embedder?.id ?? null };
  }
}
