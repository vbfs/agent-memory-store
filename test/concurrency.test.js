import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import path from "path";
import { MemoryStore } from "../src/store/memory-store.js";
import { HashEmbedder } from "../src/embeddings.js";
import { tempDir, ROOT } from "./helpers.js";

const WORKERS = 4;
const PER_WORKER = 500;

function runWorker(file, agent) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", path.join(ROOT, "test/fixtures/concurrent-worker.js"), file, agent, String(PER_WORKER)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}: ${err}`))));
  });
}

test(`${WORKERS} processes writing to one store: no lost writes, no SQLITE_BUSY`, { timeout: 120_000 }, async () => {
  const [dir, cleanup] = tempDir();
  try {
    const file = path.join(dir, "store.db");
    MemoryStore.open(file).close(); // create schema once, like the first agent would
    const results = await Promise.all(Array.from({ length: WORKERS }, (_, i) => runWorker(file, `agent-${i}`)));

    for (const r of results) assert.equal(r.errors, 0, `${r.agent} had errors`);
    assert.ok(results.some((r) => r.seenOthers > 0), "agents see each other's writes");

    const s = MemoryStore.open(file, { embedder: new HashEmbedder() });
    assert.equal(s.list().total, WORKERS * PER_WORKER);
    for (let i = 0; i < WORKERS; i++) assert.equal(s.list({ agent: `agent-${i}` }).total, PER_WORKER);
    assert.equal(s.getState("counter").value, WORKERS * (PER_WORKER / 10), "CAS counter lost no increments");
    assert.doesNotThrow(() => s.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')"));
    assert.equal(s.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    s.close();
  } finally {
    cleanup();
  }
});
