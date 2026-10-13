#!/usr/bin/env node
/**
 * Golden-set benchmark: bilingual (PT-BR/EN) agent-curated memories, the
 * workload this server is built for. Memories are written through the real
 * write path and queried through the real search path.
 *
 * Usage:
 *   node benchmarks/golden.js [--model granite-97m-multilingual] [--modes hybrid,bm25,semantic]
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MemoryStore } from "../src/store/memory-store.js";
import { createEmbedder, DEFAULT_MODEL } from "../src/embeddings.js";
import { withCache } from "./lib/cached-embedder.js";
import { recallAny, recallAll, reciprocalRank, ndcgAny, mean } from "./lib/metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;

function parseArgs(argv) {
  const opts = { model: process.env.AGENT_MEMORY_MODEL || DEFAULT_MODEL, modes: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") opts.model = argv[++i];
    else if (argv[i] === "--modes") opts.modes = argv[++i].split(",");
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  opts.modes ??= opts.model === "none" ? ["bm25"] : ["hybrid", "bm25", "semantic"];
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const data = JSON.parse(readFileSync(path.join(__dirname, "golden", "dataset.json"), "utf8"));
const embedder = withCache(createEmbedder(opts.model));
if (embedder && !(await embedder.load())) throw new Error(`Model ${opts.model} failed to load`);

const NOW = Date.parse("2026-06-01T12:00:00Z");
let now = NOW;
const store = MemoryStore.open(":memory:", { embedder, clock: () => now });

// Oldest first, through the production write path.
const memories = [...data.memories].sort((a, b) => b.created_days_ago - a.created_days_ago);
for (const m of memories) {
  now = NOW - m.created_days_ago * DAY;
  await store.write({ id: m.id, topic: m.topic, content: m.content, tags: m.tags, agent: m.agent, importance: m.importance });
}
now = NOW;
await store.flushEmbeddings();

const langOf = new Map(data.memories.map((m) => [m.id, m.lang]));
const rows = [];
for (const q of data.queries) {
  const gold = new Set(q.relevant);
  const row = { id: q.id, type: q.type, lang: q.lang, targetLang: langOf.get(q.relevant[0]), metrics: {} };
  for (const mode of opts.modes) {
    const { results } = await store.search({ query: q.query, limit: 10, mode, tags: q.filters?.tags, agent: q.filters?.agent });
    const ranked = results.map((r) => r.id);
    row.metrics[mode] = {
      "recall_any@5": recallAny(ranked, gold, 5),
      "recall_all@5": recallAll(ranked, gold, 5),
      "recall_any@1": recallAny(ranked, gold, 1),
      mrr: reciprocalRank(ranked, gold),
      "ndcg@10": ndcgAny(ranked, gold, gold.size, 10),
    };
    if (mode === opts.modes[0]) row.top = ranked.slice(0, 5);
  }
  rows.push(row);
}
store.close();

function summarize(subset, mode) {
  const keys = Object.keys(subset[0].metrics[mode]);
  return Object.fromEntries(keys.map((k) => [k, mean(subset.map((r) => r.metrics[mode][k]))]));
}
const pct = (v) => `${(v * 100).toFixed(1)}%`.padStart(7);

console.log(`Golden set v${data.version}: ${data.memories.length} memories, ${data.queries.length} queries · model ${embedder?.id ?? "none"}\n`);
console.log("mode      |  Hit@1  | R_any@5 | R_all@5 |  MRR  | NDCG@10");
console.log("----------|---------|---------|---------|-------|--------");
const overall = {};
for (const mode of opts.modes) {
  const s = (overall[mode] = summarize(rows, mode));
  console.log(`${mode.padEnd(9)} | ${pct(s["recall_any@1"])} | ${pct(s["recall_any@5"])} | ${pct(s["recall_all@5"])} | ${s.mrr.toFixed(3)} | ${s["ndcg@10"].toFixed(3)}`);
}

const groups = {};
const addGroup = (name, subset) => {
  if (!subset.length) return;
  groups[name] = { n: subset.length, ...Object.fromEntries(opts.modes.map((m) => [m, summarize(subset, m)])) };
};
for (const type of [...new Set(rows.map((r) => r.type))].sort()) addGroup(`type:${type}`, rows.filter((r) => r.type === type));
addGroup("lang:pt→pt", rows.filter((r) => r.lang === "pt" && r.targetLang === "pt"));
addGroup("lang:en→en", rows.filter((r) => r.lang === "en" && r.targetLang === "en"));
addGroup("lang:pt→en", rows.filter((r) => r.lang === "pt" && r.targetLang === "en"));
addGroup("lang:en→pt", rows.filter((r) => r.lang === "en" && r.targetLang === "pt"));

console.log(`\nMRR by group (${opts.modes.join(" / ")}):`);
for (const [name, g] of Object.entries(groups)) {
  console.log(`  ${name.padEnd(20)} n=${String(g.n).padStart(3)}  ${opts.modes.map((m) => g[m].mrr.toFixed(3)).join("  ")}`);
}

const outDir = path.join(__dirname, "results");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `golden-${opts.model}.json`);
writeFileSync(
  outFile,
  JSON.stringify({ meta: { dataset: `golden v${data.version}`, model: embedder?.id ?? null, node: process.version, date: new Date().toISOString() }, overall, groups, perQuery: rows }, null, 1),
);
console.log(`\nresults: ${path.relative(process.cwd(), outFile)}`);
