#!/usr/bin/env node
/**
 * Benchmark: agent-memory-store performance at scale.
 *
 * Tests write, read, search (BM25), list, and delete operations
 * at 100, 1K, 5K, and 10K chunks to measure scalability.
 *
 * Usage: node benchmark.js
 */

import {
  initStore,
  writeChunk,
  readChunk,
  searchChunks,
  listChunks,
  deleteChunk,
  setState,
  getState,
} from "./src/store.js";

const SIZES = [100, 1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000];

function randomWord() {
  const words = [
    "auth",
    "api",
    "database",
    "migration",
    "deploy",
    "cache",
    "queue",
    "webhook",
    "middleware",
    "router",
    "schema",
    "model",
    "service",
    "controller",
    "handler",
    "pipeline",
    "worker",
    "cron",
    "batch",
    "stream",
    "socket",
    "proxy",
    "gateway",
    "monitor",
    "alert",
    "config",
    "secret",
    "token",
    "session",
    "permission",
    "role",
    "tenant",
    "billing",
    "invoice",
    "payment",
    "subscription",
    "notification",
    "email",
    "sms",
    "push",
    "template",
    "render",
    "search",
    "index",
    "vector",
    "embedding",
    "similarity",
    "ranking",
  ];
  return words[Math.floor(Math.random() * words.length)];
}

function randomSentence(n = 10) {
  return Array.from({ length: n }, randomWord).join(" ");
}

function randomTags() {
  const count = 1 + Math.floor(Math.random() * 3);
  return Array.from({ length: count }, randomWord);
}

async function time(label, fn) {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { label, ms, result };
}

async function bench(size) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${size.toLocaleString()} CHUNKS`);
  console.log(`${"=".repeat(60)}`);

  // ── Write ──
  const ids = [];
  const { ms: writeTotal } = await time("write", async () => {
    for (let i = 0; i < size; i++) {
      const r = await writeChunk({
        topic: `${randomWord()} — ${randomSentence(4)}`,
        content: randomSentence(50),
        agent: ["architect", "dev", "qa", "pm"][i % 4],
        tags: randomTags(),
        importance: ["low", "medium", "high", "critical"][i % 4],
      });
      ids.push(r.id);
    }
  });
  const writeAvg = writeTotal / size;
  console.log(
    `  write     ${writeTotal.toFixed(0)}ms total | ${writeAvg.toFixed(2)}ms/op`,
  );

  // ── Read (random 100) ──
  const readSample = 100;
  const { ms: readTotal } = await time("read", async () => {
    for (let i = 0; i < readSample; i++) {
      const id = ids[Math.floor(Math.random() * ids.length)];
      await readChunk(id);
    }
  });
  console.log(
    `  read      ${readTotal.toFixed(0)}ms for ${readSample} reads | ${(readTotal / readSample).toFixed(2)}ms/op`,
  );

  // ── Search BM25 (10 queries) ──
  const queries = Array.from({ length: 10 }, () => randomSentence(3));
  const { ms: searchBm25Total } = await time("search_bm25", async () => {
    for (const q of queries) {
      await searchChunks({ query: q, topK: 6, mode: "bm25" });
    }
  });
  console.log(
    `  search    ${searchBm25Total.toFixed(0)}ms for 10 queries | ${(searchBm25Total / 10).toFixed(1)}ms/query (bm25)`,
  );

  // ── List ──
  const { ms: listMs } = await time("list", async () => {
    await listChunks();
  });
  console.log(`  list      ${listMs.toFixed(1)}ms`);

  // ── List with filter ──
  const { ms: listFilterMs } = await time("list_filter", async () => {
    await listChunks({ agent: "architect", tags: ["auth"] });
  });
  console.log(`  list+filt ${listFilterMs.toFixed(1)}ms`);

  // ── State KV ──
  const { ms: stateMs } = await time("state", async () => {
    for (let i = 0; i < 100; i++) {
      await setState(`bench_key_${i}`, { counter: i, data: randomSentence(5) });
    }
    for (let i = 0; i < 100; i++) {
      await getState(`bench_key_${i}`);
    }
  });
  console.log(
    `  state     ${stateMs.toFixed(0)}ms for 200 ops (100 set + 100 get)`,
  );

  // ── Delete all ──
  const { ms: deleteTotal } = await time("delete", async () => {
    for (const id of ids) {
      await deleteChunk(id);
    }
  });
  console.log(
    `  delete    ${deleteTotal.toFixed(0)}ms total | ${(deleteTotal / size).toFixed(2)}ms/op`,
  );

  return {
    size,
    writeAvg,
    readAvg: readTotal / readSample,
    searchAvg: searchBm25Total / 10,
    listMs,
    stateAvg: stateMs / 200,
  };
}

// ── Main ──

console.log("agent-memory-store benchmark");
console.log(`Node ${process.version} | ${process.platform} ${process.arch}`);

await initStore();

const results = [];
for (const size of SIZES) {
  results.push(await bench(size));
}

console.log(`\n${"=".repeat(60)}`);
console.log("  SUMMARY (ms)");
console.log(`${"=".repeat(60)}`);
console.log("  chunks  | write/op | read/op | search/q | list   | state/op");
console.log("  --------|----------|---------|----------|--------|--------");
for (const r of results) {
  console.log(
    `  ${String(r.size).padStart(6)} | ${r.writeAvg.toFixed(2).padStart(8)} | ${r.readAvg.toFixed(2).padStart(7)} | ${r.searchAvg.toFixed(1).padStart(8)} | ${r.listMs.toFixed(1).padStart(6)} | ${r.stateAvg.toFixed(2).padStart(6)}`,
  );
}

console.log("\nDone.");
process.exit(0);
