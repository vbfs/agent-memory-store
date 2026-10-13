#!/usr/bin/env node
/**
 * LongMemEval-S retrieval benchmark, run through the production MemoryStore
 * (same FTS query builder, vector index, fusion and ranking as the MCP server).
 *
 * Protocol follows the official LongMemEval retrieval evaluation:
 *   - LongMemEval-S cleaned, session granularity, user turns only
 *   - 470 evaluable questions (abstention and no-evidence questions excluded)
 *   - recall_any@k, recall_all@k, ndcg_any@k
 *
 * Usage:
 *   node benchmarks/longmemeval.js [--model granite-97m-multilingual] [--limit N]
 *                                  [--modes hybrid,bm25,semantic] [--with-assistant]
 *                                  [--fusions rrf:0.5,convex:0.7]   (extra hybrid variants)
 *                                  [--sample N]  (deterministic sample, stratified by question type)
 */

import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MemoryStore } from "../src/store/memory-store.js";
import { createEmbedder, DEFAULT_MODEL } from "../src/embeddings.js";
import { withCache } from "./lib/cached-embedder.js";
import { loadDataset, isEvaluable, buildSessionCorpus, parseDate } from "./lib/dataset.js";
import { recallAny, recallAll, ndcgAny, mean } from "./lib/metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = { model: process.env.AGENT_MEMORY_MODEL || DEFAULT_MODEL, limit: null, sample: null, modes: null, withAssistant: false, fusions: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") opts.model = argv[++i];
    else if (a === "--limit") opts.limit = parseInt(argv[++i], 10);
    else if (a === "--sample") opts.sample = parseInt(argv[++i], 10);
    else if (a === "--modes") opts.modes = argv[++i].split(",");
    else if (a === "--with-assistant") opts.withAssistant = true;
    else if (a === "--fusions") opts.fusions = argv[++i].split(",");
    else throw new Error(`Unknown argument ${a}`);
  }
  opts.modes ??= opts.model === "none" ? ["bm25"] : ["hybrid", "bm25", "semantic"];
  // Each fusion variant is reported as its own row, e.g. "hybrid[convex:0.7]".
  opts.runs = [
    ...opts.modes.map((mode) => ({ name: mode, mode })),
    ...opts.fusions.map((f) => {
      const [method, w] = f.split(":");
      return { name: `hybrid[${f}]`, mode: "hybrid", fusion: { method, semanticWeight: Number(w) } };
    }),
  ];
  return opts;
}

const KS = [5, 10];
const opts = parseArgs(process.argv.slice(2));
const embedder = withCache(createEmbedder(opts.model));
if (embedder && !(await embedder.load())) throw new Error(`Model ${opts.model} failed to load`);

let questions = await loadDataset();
const total = questions.length;
questions = questions.filter(isEvaluable);
const evaluable = questions.length;
if (opts.limit) questions = questions.slice(0, opts.limit);
if (opts.sample) questions = stratifiedSample(questions, opts.sample);

/** Evenly spaced picks within each question type, proportional to its share. */
function stratifiedSample(qs, n) {
  const byType = new Map();
  for (const q of qs) byType.set(q.question_type, [...(byType.get(q.question_type) ?? []), q]);
  const picked = [];
  for (const group of byType.values()) {
    const k = Math.max(1, Math.round((group.length / qs.length) * n));
    for (let i = 0; i < k; i++) picked.push(group[Math.floor((i * group.length) / k)]);
  }
  return picked;
}

console.log(`LongMemEval-S (cleaned) · session granularity · ${opts.withAssistant ? "user+assistant turns (NON-OFFICIAL variant)" : "user turns (official)"}`);
console.log(`model: ${embedder?.id ?? "none (keyword only)"} · questions: ${questions.length} of ${total} (excluded ${total - evaluable} abstention/no-evidence)\n`);

const perQuestion = [];
const t0 = performance.now();

for (let qi = 0; qi < questions.length; qi++) {
  const q = questions[qi];
  const { docs, gold } = buildSessionCorpus(q, { withAssistant: opts.withAssistant });
  const questionTime = Date.parse(parseDate(q.question_date) ?? new Date().toISOString());
  const store = MemoryStore.open(":memory:", { embedder, clock: () => questionTime });

  for (const d of docs) {
    store.importMemory({
      id: d.id,
      topic: "conversation",
      content: d.text || "(empty)",
      createdAt: d.date ?? undefined,
      updatedAt: d.date ?? undefined,
    });
  }
  await store.flushEmbeddings();

  const row = { id: q.question_id, type: q.question_type, gold: gold.size, metrics: {} };
  for (const { name, mode, fusion } of opts.runs) {
    const { results } = await store.search({ query: q.question, limit: 50, mode, ...(fusion && { fusion }) });
    const ranked = results.map((r) => r.id);
    const m = {};
    for (const k of KS) {
      m[`recall_any@${k}`] = recallAny(ranked, gold, k);
      m[`recall_all@${k}`] = recallAll(ranked, gold, k);
      m[`ndcg_any@${k}`] = ndcgAny(ranked, gold, gold.size, k);
    }
    row.metrics[name] = m;
  }
  perQuestion.push(row);
  store.close();
  questions[qi] = null; // the dataset is ~1 GB in memory; release as we go

  const done = qi + 1;
  const elapsed = (performance.now() - t0) / 1000;
  process.stderr.write(`\r  ${done}/${questions.length} · ${elapsed.toFixed(0)}s · ETA ${((elapsed / done) * (questions.length - done)).toFixed(0)}s   `);
}
process.stderr.write("\n\n");

function summarize(rows, mode) {
  const keys = Object.keys(rows[0].metrics[mode]);
  return Object.fromEntries(keys.map((k) => [k, mean(rows.map((r) => r.metrics[mode][k]))]));
}

const pct = (v) => `${(v * 100).toFixed(1)}%`.padStart(7);
const overall = {};
console.log("mode      | R_any@5 | R_all@5 | R_any@10 | R_all@10 | NDCG@10");
console.log("----------|---------|---------|----------|----------|--------");
for (const { name } of opts.runs) {
  const s = (overall[name] = summarize(perQuestion, name));
  console.log(
    `${name.padEnd(9)} | ${pct(s["recall_any@5"])} | ${pct(s["recall_all@5"])} | ${pct(s["recall_any@10"])}  | ${pct(s["recall_all@10"])}  | ${s["ndcg_any@10"].toFixed(3)}`,
  );
}

const byType = {};
const primary = opts.runs[0].name;
console.log(`\nby question type (${primary}):`);
for (const type of [...new Set(perQuestion.map((r) => r.type))].sort()) {
  const rows = perQuestion.filter((r) => r.type === type);
  const s = (byType[type] = { n: rows.length, ...summarize(rows, primary) });
  console.log(`  ${type.padEnd(27)} n=${String(rows.length).padStart(3)}  R_any@5 ${pct(s["recall_any@5"])}  R_all@5 ${pct(s["recall_all@5"])}  NDCG@10 ${s["ndcg_any@10"].toFixed(3)}`);
}

const seconds = (performance.now() - t0) / 1000;
console.log(`\ncompleted in ${seconds.toFixed(0)}s${embedder?.misses != null ? ` (embedding cache: ${embedder.hits} hits, ${embedder.misses} computed)` : ""}`);

const outDir = path.join(__dirname, "results");
mkdirSync(outDir, { recursive: true });
const suffix = `${opts.model}${opts.withAssistant ? "-with-assistant" : ""}${opts.limit ? `-limit${opts.limit}` : ""}${opts.sample ? `-sample${opts.sample}` : ""}`;
const outFile = path.join(outDir, `longmemeval-${suffix}.json`);
writeFileSync(
  outFile,
  JSON.stringify(
    {
      meta: {
        dataset: "LongMemEval-S (cleaned)",
        granularity: "session",
        turns: opts.withAssistant ? "user+assistant (non-official)" : "user (official)",
        model: embedder?.id ?? null,
        questions: questions.length,
        selection: opts.sample ? `stratified sample of ${opts.sample}` : opts.limit ? `first ${opts.limit}` : "all evaluable",
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        date: new Date().toISOString(),
        seconds: Math.round(seconds),
      },
      overall,
      byType,
      perQuestion,
    },
    null,
    1,
  ),
);
console.log(`results: ${path.relative(process.cwd(), outFile)}`);
