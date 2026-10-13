import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { MemoryStore, SCHEMA_VERSION } from "../src/store/memory-store.js";
import { HashEmbedder } from "../src/embeddings.js";
import { migrateLegacyFiles } from "../src/migrate.js";
import { tempDir } from "./helpers.js";

const DAY = 86_400_000;

function memStore(opts = {}) {
  return MemoryStore.open(":memory:", { embedder: new HashEmbedder(), ...opts });
}

function fakeClock(start = Date.parse("2026-01-01T00:00:00Z")) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => (t += ms);
  return clock;
}

async function codeOf(promiseOrFn) {
  try {
    await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
  } catch (e) {
    return e.code;
  }
  return null;
}

describe("write / read / delete", () => {
  test("creates with generated id and reads back", async () => {
    const s = memStore();
    const m = await s.write({ topic: " Auth decision ", content: "JWT", tags: ["Auth", " auth ", "Decision"], agent: "pm" });
    assert.match(m.id, /^[0-9a-f]{12}$/);
    assert.equal(m.created, true);
    assert.equal(m.version, 1);
    assert.equal(m.topic, "Auth decision");
    assert.deepEqual(m.tags, ["auth", "decision"]);
    const r = s.get(m.id);
    assert.equal(r.content, "JWT");
    assert.equal(r.agent, "pm");
    assert.equal(s.delete(m.id), true);
    assert.equal(s.get(m.id), null);
    assert.equal(s.delete(m.id), false);
  });

  test("custom id creates then updates in place", async () => {
    const s = memStore();
    const a = await s.write({ id: "db-choice", topic: "DB", content: "Postgres 15", tags: ["db"], importance: "high" });
    assert.equal(a.created, true);
    const b = await s.write({ id: "db-choice", topic: "DB", content: "Postgres 16", agent: "dba" });
    assert.equal(b.created, false);
    assert.equal(b.version, 2);
    assert.equal(b.createdAt, a.createdAt);
    assert.deepEqual(b.tags, ["db"], "omitted tags are kept");
    assert.equal(b.importance, "high", "omitted importance is kept");
    assert.equal(b.updatedBy, "dba");
    assert.equal(s.list().total, 1);
  });

  test("update keeps the FTS index consistent (no orphan rows)", async () => {
    const s = memStore();
    const m = await s.write({ topic: "Cache", content: "We use memcached" });
    await s.write({ id: m.id, topic: "Cache", content: "We use redis" });
    assert.doesNotThrow(() => s.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')"));
    assert.equal((await s.search({ query: "memcached", mode: "bm25" })).results.length, 0);
    assert.equal((await s.search({ query: "redis", mode: "bm25" })).results.length, 1);
    s.delete(m.id);
    assert.doesNotThrow(() => s.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')"));
  });

  test("validates input", async () => {
    const s = memStore();
    assert.equal(await codeOf(s.write({ topic: "", content: "x" })), "INVALID");
    assert.equal(await codeOf(s.write({ topic: "x", content: "  " })), "INVALID");
    assert.equal(await codeOf(s.write({ topic: "x", content: "y", importance: "urgent" })), "INVALID");
    assert.equal(await codeOf(s.write({ topic: "x", content: "y", id: "has space" })), "INVALID");
    assert.equal(await codeOf(s.write({ topic: "x", content: "y", ttlDays: -1 })), "INVALID");
    assert.equal(await codeOf(s.write({ topic: "x", content: "y", tags: "auth" })), "INVALID");
    assert.equal(await codeOf(s.search({ query: "x", since: "not a date" })), "INVALID");
    assert.equal(await codeOf(s.search({ query: "" })), "INVALID");
  });

  test("refuses secrets but allows references and placeholders", async () => {
    const s = memStore();
    for (const content of [
      "key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345",
      "AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
      "token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
      "postgres://app:hunter2secret@db.internal:5432/app",
    ]) {
      assert.equal(await codeOf(s.write({ topic: "creds", content })), "SECRET", content);
    }
    for (const content of [
      "DB password lives in 1Password: Prod/Postgres",
      "postgres://app:${DB_PASSWORD}@db.internal:5432/app",
      "postgres://app:<password>@db/app",
      "The task asks to rotate the API key every 90 days",
    ]) {
      assert.equal(await codeOf(s.write({ topic: "creds ref", content })), null, content);
    }
    assert.equal(await codeOf(() => s.setState("k", { token: "xoxb-1234567890-abcdefghij" })), "SECRET");
  });
});

describe("compare-and-set", () => {
  test("write with expected_version", async () => {
    const s = memStore();
    assert.equal(await codeOf(s.write({ id: "x", topic: "t", content: "c", expectedVersion: 1 })), "CONFLICT");
    await s.write({ id: "x", topic: "t", content: "c", expectedVersion: 0 });
    assert.equal(await codeOf(s.write({ id: "x", topic: "t", content: "c2", expectedVersion: 0 })), "CONFLICT");
    const m = await s.write({ id: "x", topic: "t", content: "c2", expectedVersion: 1 });
    assert.equal(m.version, 2);
    assert.equal(s.get("x").content, "c2");
  });

  test("state with expected_version", () => {
    const s = memStore();
    assert.equal(s.getState("phase"), null);
    assert.equal(s.setState("phase", "plan", { expectedVersion: 0, agent: "a" }).version, 1);
    assert.equal(codeOfSync(() => s.setState("phase", "build", { expectedVersion: 0 })), "CONFLICT");
    assert.equal(s.setState("phase", "build", { expectedVersion: 1 }).version, 2);
    assert.equal(s.setState("phase", { n: 1 }).version, 3, "unguarded write always succeeds");
    const st = s.getState("phase");
    assert.deepEqual(st.value, { n: 1 });
    assert.equal(st.version, 3);
  });
});

function codeOfSync(fn) {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
}

describe("expiry", () => {
  test("expired memories disappear from get, list and search without a restart", async () => {
    const clock = fakeClock();
    const s = memStore({ clock });
    const tmp = await s.write({ topic: "Rate limit", content: "ZAP API allows 1 req/s", ttlDays: 1 });
    await s.write({ topic: "Rate policy", content: "Always respect API limits" });
    assert.equal(s.list().total, 2);
    clock.advance(2 * DAY);
    assert.equal(s.get(tmp.id), null);
    assert.equal(s.list().total, 1);
    const { results } = await s.search({ query: "ZAP rate limit" });
    assert.ok(results.every((r) => r.id !== tmp.id));
  });

  test("an expired id counts as non-existent for writes", async () => {
    const clock = fakeClock();
    const s = memStore({ clock });
    await s.write({ id: "tmp", topic: "t", content: "old", ttlDays: 1 });
    clock.advance(2 * DAY);
    const m = await s.write({ id: "tmp", topic: "t", content: "new", expectedVersion: 0 });
    assert.equal(m.created, true);
    assert.equal(m.version, 1);
    assert.equal(m.expiresAt, null);
  });

  test("ttl null removes an expiry; omitted ttl keeps it", async () => {
    const clock = fakeClock();
    const s = memStore({ clock });
    const m = await s.write({ id: "t", topic: "t", content: "c", ttlDays: 1 });
    assert.ok(m.expiresAt);
    assert.ok((await s.write({ id: "t", topic: "t", content: "c2" })).expiresAt, "kept");
    assert.equal((await s.write({ id: "t", topic: "t", content: "c3", ttlDays: null })).expiresAt, null);
    clock.advance(5 * DAY);
    assert.ok(s.get("t"));
  });
});

describe("filters", () => {
  test("tags match exactly (no LIKE wildcards)", async () => {
    const s = memStore();
    await s.write({ topic: "OAuth flow", content: "PKCE", tags: ["oauth"] });
    await s.write({ topic: "Auth", content: "JWT", tags: ["auth"] });
    assert.equal(s.list({ tags: ["auth"] }).total, 1);
    assert.equal(s.list({ tags: ["a_th"] }).total, 0);
    assert.equal(s.list({ tags: ["%"] }).total, 0);
    assert.equal(s.list({ tags: ["AUTH", "oauth"] }).total, 2);
    const { results } = await s.search({ query: "flow JWT PKCE", tags: ["auth"] });
    assert.deepEqual(results.map((r) => r.topic), ["Auth"]);
  });

  test("agent and date filters apply to both retrievers", async () => {
    const clock = fakeClock();
    const s = memStore({ clock });
    await s.write({ topic: "Deploy notes", content: "staging on ECS", agent: "infra" });
    clock.advance(10 * DAY);
    await s.write({ topic: "Deploy notes 2", content: "staging on ECS fargate", agent: "backend" });
    for (const mode of ["hybrid", "bm25", "semantic"]) {
      const byAgent = await s.search({ query: "staging deploy", agent: "infra", mode });
      assert.deepEqual(byAgent.results.map((r) => r.agent), ["infra"], mode);
      const recent = await s.search({ query: "staging deploy", since: new Date(clock() - DAY).toISOString(), mode });
      assert.deepEqual(recent.results.map((r) => r.agent), ["backend"], mode);
    }
    assert.equal(s.list({ until: new Date(clock() - DAY).toISOString() }).total, 1);
  });

  test("list paginates newest first with total", async () => {
    const clock = fakeClock();
    const s = memStore({ clock });
    for (let i = 0; i < 5; i++) {
      await s.write({ topic: `m${i}`, content: "x" });
      clock.advance(1000);
    }
    const p1 = s.list({ limit: 2 });
    assert.equal(p1.total, 5);
    assert.deepEqual(p1.items.map((m) => m.topic), ["m4", "m3"]);
    assert.equal(p1.items[0].content, undefined);
    assert.deepEqual(s.list({ limit: 2, offset: 4 }).items.map((m) => m.topic), ["m0"]);
  });
});

describe("search", () => {
  test("modes, scores and top_k", async () => {
    const s = memStore();
    const auth = await s.write({ topic: "Auth — JWT decision", content: "Stateless JWT with RS256 keys", tags: ["auth"] });
    await s.write({ topic: "Staging deploy", content: "ECS Fargate, node 22" });
    await s.write({ topic: "Database", content: "Postgres 16 with pgvector" });

    const hybrid = await s.search({ query: "What did we decide about JWT auth?" });
    assert.equal(hybrid.mode, "hybrid");
    assert.equal(hybrid.results[0].id, auth.id);
    assert.ok(hybrid.results[0].score > 0.9 && hybrid.results[0].score <= 1);
    assert.deepEqual(hybrid.results[0].matched.sort(), ["keyword", "semantic"]);
    assert.ok(hybrid.results[0].similarity > 0);

    const bm25 = await s.search({ query: "JWT", mode: "bm25" });
    assert.equal(bm25.mode, "bm25");
    assert.equal(bm25.results.length, 1);
    assert.equal(bm25.results[0].similarity, null);

    const sem = await s.search({ query: "JWT tokens", mode: "semantic" });
    assert.equal(sem.mode, "semantic");
    assert.equal(sem.results[0].id, auth.id);

    assert.equal((await s.search({ query: "deploy database auth", limit: 2 })).results.length, 2);
    const strict = await s.search({ query: "JWT auth", minScore: 0.9 });
    assert.ok(strict.results.length >= 1 && strict.results.every((r) => r.score >= 0.9));
  });

  test("keyword-only store (no embedder) still works", async () => {
    const s = MemoryStore.open(":memory:", { embedder: null });
    await s.write({ topic: "Auth", content: "JWT" });
    const r = await s.search({ query: "auth?", mode: "semantic" });
    assert.equal(r.mode, "bm25");
    assert.equal(r.results.length, 1);
  });

  test("importance and recency only break near-ties", async () => {
    const clock = fakeClock();
    const s = memStore({ clock });
    const strong = await s.write({ topic: "Redis cache eviction policy", content: "allkeys-lru for redis cache", importance: "low" });
    clock.advance(400 * DAY);
    await s.write({ topic: "Misc", content: "the cache is warm", importance: "critical" });
    const { results } = await s.search({ query: "redis cache eviction policy" });
    assert.equal(results[0].id, strong.id);
  });

  test("reports likely duplicates on write", async () => {
    const s = memStore();
    const a = await s.write({ topic: "Auth decision", content: "We chose JWT with RS256 for the API gateway" });
    const b = await s.write({ topic: "auth decision", content: "something else" });
    assert.deepEqual(b.duplicates.map((d) => d.id), [a.id]);
    const c = await s.write({ topic: "API gateway auth", content: "We chose JWT with RS256 for the API gateway" });
    assert.ok(c.duplicates.some((d) => d.id === a.id && d.reason.startsWith("similar")));
    const d = await s.write({ topic: "Unrelated", content: "Lunch is at noon" });
    assert.deepEqual(d.duplicates, []);
  });
});

describe("embeddings lifecycle", () => {
  class SlowEmbedder extends HashEmbedder {
    constructor() {
      super();
      this.ready = false;
    }
    isReady() {
      return this.ready;
    }
    async load() {
      await new Promise((r) => setTimeout(r, 20));
      this.ready = true;
      return true;
    }
    async embedDocuments(texts) {
      await new Promise((r) => setTimeout(r, 30));
      return super.embedDocuments(texts);
    }
  }

  test("background embedding never stores a vector for stale content", async () => {
    const s = MemoryStore.open(":memory:", { embedder: new SlowEmbedder() });
    const m = await s.write({ id: "x", topic: "t", content: "first version" });
    s.warmup();
    await new Promise((r) => setTimeout(r, 35)); // drain is now embedding "first version"
    await s.write({ id: m.id, topic: "t", content: "second version" });
    await s.flushEmbeddings();
    const v = s.db.prepare("SELECT v.content_hash AS vh, c.content_hash AS ch FROM vectors v JOIN chunks c ON c.id = v.chunk_id").get();
    assert.equal(v.vh, v.ch);
    assert.equal(s.stats().embedded, 1);
  });

  test("updating content while the model is not ready drops the stale vector", async () => {
    const e = new SlowEmbedder();
    const s = MemoryStore.open(":memory:", { embedder: e });
    e.ready = true;
    await s.write({ id: "x", topic: "Queue", content: "We use RabbitMQ for jobs" });
    assert.equal(s.stats().embedded, 1);
    e.ready = false; // e.g. another process without the model, or model reloading
    e.load = async () => false;
    await s.write({ id: "x", topic: "Queue", content: "We moved jobs to SQS" });
    assert.equal(s.db.prepare("SELECT count(*) AS n FROM vectors").get().n, 0);
  });

  test("changing the model re-embeds everything", async () => {
    const [dir, cleanup] = tempDir();
    try {
      const file = path.join(dir, "store.db");
      const s1 = MemoryStore.open(file, { embedder: new HashEmbedder(256) });
      for (let i = 0; i < 40; i++) await s1.write({ topic: `topic ${i}`, content: `content number ${i}` });
      s1.close();
      const s2 = MemoryStore.open(file, { embedder: new HashEmbedder(128) });
      assert.equal(s2.stats().embedded, 0);
      await s2.flushEmbeddings();
      assert.deepEqual(s2.stats(), { memories: 40, embedded: 40, model: "hash-v1-128" });
      const r = await s2.search({ query: "content number 7", mode: "semantic" });
      assert.equal(r.results[0].topic, "topic 7");
      s2.close();
    } finally {
      cleanup();
    }
  });

  test("index picks up writes and deletes from another connection", async () => {
    const [dir, cleanup] = tempDir();
    try {
      const file = path.join(dir, "store.db");
      const a = MemoryStore.open(file, { embedder: new HashEmbedder() });
      const b = MemoryStore.open(file, { embedder: new HashEmbedder() });
      await a.write({ topic: "warmup", content: "warm the index" });
      await a.search({ query: "warm", mode: "semantic" });
      const m = await b.write({ topic: "Kafka topics", content: "orders.v1 partitioned by tenant" });
      const found = await a.search({ query: "kafka orders partitioned", mode: "semantic" });
      assert.equal(found.results[0].id, m.id);
      b.delete(m.id);
      const gone = await a.search({ query: "kafka orders partitioned", mode: "semantic" });
      assert.ok(gone.results.every((r) => r.id !== m.id));
      a.close();
      b.close();
    } finally {
      cleanup();
    }
  });
});

describe("migrations", () => {
  test("upgrades a v0.0.9 database in place", async () => {
    const [dir, cleanup] = tempDir();
    try {
      const file = path.join(dir, "store.db");
      const old = new DatabaseSync(file);
      // Exact schema shipped in agent-memory-store <= 0.0.9 (src/db.js).
      old.exec(`
        CREATE TABLE chunks (id TEXT PRIMARY KEY, topic TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'global',
          tags TEXT NOT NULL DEFAULT '[]', importance TEXT NOT NULL DEFAULT 'medium', content TEXT NOT NULL,
          embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT);
        CREATE INDEX idx_chunks_agent ON chunks(agent);
        CREATE INDEX idx_chunks_updated ON chunks(updated_at);
        CREATE INDEX idx_chunks_expires ON chunks(expires_at);
        CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED, topic, tags, agent, content, content='chunks', content_rowid=rowid);
        CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, id, topic, tags, agent, content) VALUES (new.rowid, new.id, new.topic, new.tags, new.agent, new.content);
        END;`);
      const ins = old.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      ins.run("a1b2c3d4e5", "Auth — JWT decision", "pm", '["auth","decision"]', "critical", "Chose JWT. Decisão final.", Buffer.alloc(16), "2025-01-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z", null);
      ins.run("f6e5d4c3b2", "Deploy", "infra", "[]", "medium", "ECS", null, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", null);
      old.prepare("INSERT INTO state VALUES (?, ?, ?)").run("phase", JSON.stringify({ step: 3 }), "2025-01-01T00:00:00.000Z");
      old.close();

      const s = MemoryStore.open(file, { embedder: new HashEmbedder() });
      assert.equal(s.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
      const m = s.get("a1b2c3d4e5");
      assert.equal(m.topic, "Auth — JWT decision");
      assert.equal(m.agent, "pm");
      assert.deepEqual(m.tags, ["auth", "decision"]);
      assert.equal(m.importance, "critical");
      assert.equal(m.createdAt, "2025-01-01T00:00:00.000Z");
      assert.deepEqual(s.getState("phase"), { key: "phase", value: { step: 3 }, version: 1, updatedAt: "2025-01-01T00:00:00.000Z", updatedBy: null });
      assert.equal((await s.search({ query: "What did we decide about auth?", mode: "bm25" })).results[0].id, "a1b2c3d4e5");
      assert.equal((await s.search({ query: "decisao", mode: "bm25" })).results.length, 1);
      await s.flushEmbeddings();
      assert.equal(s.stats().embedded, 2);
      s.close();

      // Re-opening is a no-op.
      const again = MemoryStore.open(file, { embedder: new HashEmbedder() });
      assert.equal(again.list().total, 2);
      again.close();
    } finally {
      cleanup();
    }
  });

  test("imports the legacy markdown file store", async () => {
    const [dir, cleanup] = tempDir();
    try {
      mkdirSync(path.join(dir, "chunks"));
      mkdirSync(path.join(dir, "state"));
      writeFileSync(
        path.join(dir, "chunks", "abc123.md"),
        "---\nid: abc123\ntopic: Legacy topic\nagent: old-agent\ntags: [legacy, auth]\nimportance: high\nupdated: 2024-05-01T00:00:00.000Z\n---\n\nLegacy content body\n",
      );
      writeFileSync(path.join(dir, "state", "phase.json"), JSON.stringify({ key: "phase", value: "done" }));
      const s = MemoryStore.open(path.join(dir, "store.db"), { embedder: null });
      assert.equal(await migrateLegacyFiles(s, dir), true);
      const m = s.get("abc123");
      assert.equal(m.content, "Legacy content body");
      assert.deepEqual(m.tags, ["legacy", "auth"]);
      assert.equal(m.importance, "high");
      assert.equal(s.getState("phase").value, "done");
      assert.ok(existsSync(path.join(dir, "chunks_backup")));
      assert.equal(await migrateLegacyFiles(s, dir), false);
      s.close();
    } finally {
      cleanup();
    }
  });
});
