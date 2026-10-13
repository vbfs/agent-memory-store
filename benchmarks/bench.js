#!/usr/bin/env node
/**
 * The benchmark: one command, one process, a couple of minutes, < 1 GB RAM.
 *
 *   1. Quality — golden set (150 bilingual agent memories, 120 queries),
 *      written and searched through the production MemoryStore.
 *   2. Speed — 2,000 memories in an on-disk store with the real model:
 *      p50/p95 of search (hybrid, keyword), write and read, plus RSS.
 *
 * Usage: npm run bench [-- --model arctic-embed-m-v2] [-- --memories 2000]
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { MemoryStore } from "../src/store/memory-store.js";
import { createEmbedder, DEFAULT_MODEL } from "../src/embeddings.js";
import { recallAny, reciprocalRank, mean, percentile } from "./lib/metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;
const RSS_LIMIT_MB = 1500;

const args = process.argv.slice(2);
const arg = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const model = arg("--model", process.env.AGENT_MEMORY_MODEL || DEFAULT_MODEL);
const N = Number(arg("--memories", 2000));

const rssMB = () => Math.round(process.memoryUsage().rss / 1e6);
function guard() {
  if (rssMB() > RSS_LIMIT_MB) {
    console.error(`Aborting: RSS ${rssMB()} MB exceeds ${RSS_LIMIT_MB} MB safety limit.`);
    process.exit(2);
  }
}
async function timed(fn) {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}
const ms = (xs) => `${percentile(xs, 50).toFixed(1)} / ${percentile(xs, 95).toFixed(1)}`;
const pct = (v) => `${(v * 100).toFixed(1)}%`;

const embedder = createEmbedder(model);
if (embedder && !(await embedder.load())) throw new Error(`Model ${model} failed to load`);
console.log(`agent-memory-store benchmark · model ${embedder?.id ?? "none (keyword only)"} · node ${process.version} · ${process.platform}-${process.arch}\n`);

// ─── 1. Quality: golden set ─────────────────────────────────────────────────

const data = JSON.parse(readFileSync(path.join(__dirname, "golden", "dataset.json"), "utf8"));
const NOW = Date.parse("2026-06-01T12:00:00Z");
let now = NOW;
const g = MemoryStore.open(":memory:", { embedder, clock: () => now });
for (const m of [...data.memories].sort((a, b) => b.created_days_ago - a.created_days_ago)) {
  now = NOW - m.created_days_ago * DAY;
  await g.write({ id: m.id, topic: m.topic, content: m.content, tags: m.tags, agent: m.agent, importance: m.importance });
}
now = NOW;
await g.flushEmbeddings();

const modes = embedder ? ["hybrid", "bm25", "semantic"] : ["bm25"];
const quality = {};
console.log(`1) Quality — golden set: ${data.memories.length} memories (PT-BR/EN), ${data.queries.length} queries`);
console.log("   mode       Hit@1    Recall@5   MRR");
for (const mode of modes) {
  const rows = [];
  for (const q of data.queries) {
    const { results } = await g.search({ query: q.query, limit: 10, mode, tags: q.filters?.tags, agent: q.filters?.agent });
    const ranked = results.map((r) => r.id);
    const gold = new Set(q.relevant);
    rows.push({ hit1: recallAny(ranked, gold, 1), r5: recallAny(ranked, gold, 5), rr: reciprocalRank(ranked, gold), type: q.type });
  }
  quality[mode] = {
    hit1: mean(rows.map((r) => r.hit1)),
    recall5: mean(rows.map((r) => r.r5)),
    mrr: mean(rows.map((r) => r.rr)),
    crossLingualMrr: mean(rows.filter((r) => r.type === "cross_lingual").map((r) => r.rr)),
  };
  const s = quality[mode];
  console.log(`   ${mode.padEnd(9)}  ${pct(s.hit1).padStart(6)}   ${pct(s.recall5).padStart(6)}    ${s.mrr.toFixed(3)}`);
}
g.close();
guard();

// ─── 2. Speed: on-disk store ────────────────────────────────────────────────

const SUBJECTS = ["auth service", "payments API", "PIX webhook", "checkout", "orders worker", "Kafka consumer", "Postgres", "Redis cache", "CI pipeline", "staging deploy", "serviço de notificações", "fila de conciliação", "API de antifraude", "migração de banco"];
const FACTS = ["uses JWT with RS256", "retries 3x with exponential backoff", "has a 20s timeout", "runs on ECS Fargate", "is partitioned by tenant", "usa cache com TTL de 5 minutos", "tem assinatura HMAC nos webhooks", "foi migrado para Aurora 16", "roda blue-green deploys", "exige idempotency keys"];
const memory = (i) => ({
  id: `m${i}`,
  topic: `${SUBJECTS[i % SUBJECTS.length]} — note ${i}`,
  content: `${SUBJECTS[(i * 7) % SUBJECTS.length]} ${FACTS[(i * 3) % FACTS.length]}. Ticket PAG-${1000 + i}. ${FACTS[(i * 5 + 1) % FACTS.length]}.`,
  tags: [["auth", "payments", "infra", "db", "data"][i % 5]],
});
const QUERIES = ["What did we decide about auth tokens?", "como funciona o webhook do PIX?", "Postgres migration", "qual o timeout da API de antifraude?", "PAG-1234", "staging deploy strategy"];

const dir = mkdtempSync(path.join(tmpdir(), "ams-bench-"));
const store = MemoryStore.open(path.join(dir, "store.db"), { embedder });
const tEmbed = performance.now();
store.db.exec("BEGIN");
for (let i = 0; i < N; i++) store.importMemory(memory(i));
store.db.exec("COMMIT");
await store.flushEmbeddings();
const embedSec = (performance.now() - tEmbed) / 1000;
guard();
await store.search({ query: "warmup" });

const t = { hybrid: [], bm25: [], write: [], read: [] };
for (let round = 0; round < 10; round++) {
  for (const q of QUERIES) {
    if (embedder) t.hybrid.push(await timed(() => store.search({ query: q })));
    t.bm25.push(await timed(() => store.search({ query: q, mode: "bm25" })));
  }
}
for (let i = 0; i < 50; i++) {
  const m = memory(N + i);
  t.write.push(await timed(() => store.write({ topic: m.topic, content: m.content, tags: m.tags })));
  t.read.push(await timed(() => store.get(`m${(i * 37) % N}`)));
}
const peakRss = rssMB();
store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n2) Speed — ${N.toLocaleString("en")} memories on disk (p50 / p95 ms)`);
if (embedder) console.log(`   search hybrid   ${ms(t.hybrid)}`);
console.log(`   search keyword  ${ms(t.bm25)}`);
console.log(`   write           ${ms(t.write)}   (includes embedding + duplicate check)`);
console.log(`   read            ${ms(t.read)}`);
if (embedder) console.log(`   embed backfill  ${Math.round(N / embedSec)} memories/s`);
console.log(`   process RSS     ${peakRss} MB (model + index + runtime)`);

const out = {
  meta: { model: embedder?.id ?? null, node: process.version, platform: `${process.platform}-${process.arch}`, date: new Date().toISOString() },
  quality,
  speed: {
    memories: N,
    searchHybridMs: embedder ? { p50: percentile(t.hybrid, 50), p95: percentile(t.hybrid, 95) } : null,
    searchKeywordMs: { p50: percentile(t.bm25, 50), p95: percentile(t.bm25, 95) },
    writeMs: { p50: percentile(t.write, 50), p95: percentile(t.write, 95) },
    readMs: { p50: percentile(t.read, 50), p95: percentile(t.read, 95) },
    embedPerSec: embedder ? Math.round(N / embedSec) : null,
    rssMB: peakRss,
  },
};
mkdirSync(path.join(__dirname, "results"), { recursive: true });
const file = path.join(__dirname, "results", `bench-${model}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nresults: ${path.relative(process.cwd(), file)}`);
