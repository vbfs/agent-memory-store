#!/usr/bin/env node
/**
 * LongMemEval Benchmark for agent-memory-store.
 *
 * Evaluates retrieval quality (Recall@k, NDCG@k) on 500 long-term memory
 * questions from the LongMemEval-S dataset (ICLR 2025).
 *
 * Usage:
 *   node benchmarks/longmemeval_bench.js [options]
 *
 * Options:
 *   --limit N          Run only first N questions (default: all)
 *   --mode MODE        hybrid | bm25 | semantic | all (default: all)
 *   --granularity G    session | turn | hybrid (default: session)
 *   --top-k N          Top-K for retrieval (default: 10)
 */

import { loadDataset, getRelevantSessionIds, sessionsToChunks, sessionsToTurnChunks, sessionsToHybridChunks } from "./lib/dataset.js";
import { recallAtK, ndcgAtK } from "./lib/metrics.js";
import { BenchStore } from "./lib/bench-store.js";
import { embed, prepareText, warmup } from "../src/embeddings.js";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CLI Args ───────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: null, mode: "all", granularity: "session", topK: 10 };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--limit":
        opts.limit = parseInt(args[++i], 10);
        break;
      case "--mode":
        opts.mode = args[++i];
        break;
      case "--granularity":
        opts.granularity = args[++i];
        break;
      case "--top-k":
        opts.topK = parseInt(args[++i], 10);
        break;
    }
  }

  return opts;
}

// ─── Progress ───────────────────────────────────────────────────────────────

function progressBar(current, total, startTime) {
  const pct = ((current / total) * 100).toFixed(1);
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(0);
  const rate = current > 0 ? (elapsed / current).toFixed(1) : "?";
  const eta = current > 0 ? ((total - current) * (elapsed / current)).toFixed(0) : "?";
  process.stderr.write(
    `\r  [${current}/${total}] ${pct}% | ${elapsed}s elapsed | ~${rate}s/q | ETA ${eta}s   `,
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

const opts = parseArgs();
const MODES = opts.mode === "all" ? ["hybrid", "bm25", "semantic"] : [opts.mode];

console.log(`\n${"═".repeat(65)}`);
console.log(`  LongMemEval Benchmark — agent-memory-store`);
console.log(`  Embedding: all-MiniLM-L6-v2 (384d)`);
console.log(`  Granularity: ${opts.granularity} | Top-K: ${opts.topK}`);
console.log(`  Date: ${new Date().toISOString().slice(0, 10)}`);
console.log(`${"═".repeat(65)}\n`);

// Load dataset
const dataset = await loadDataset();
const questions = opts.limit ? dataset.slice(0, opts.limit) : dataset;
console.log(`  Questions: ${questions.length} / ${dataset.length}\n`);

// Warm up embedding model
const needsEmbeddings = MODES.some((m) => m !== "bm25");
if (needsEmbeddings) {
  process.stderr.write("[bench] Warming up embedding model...\n");
  await warmup();
  // Verify model loaded
  const test = await embed("test");
  if (!test) {
    process.stderr.write("[bench] WARNING: Embedding model not available. Semantic/hybrid will fall back to BM25.\n");
  } else {
    process.stderr.write("[bench] Embedding model ready.\n");
  }
}

// ─── Per-question results storage ───────────────────────────────────────────

// results[mode] = [ { questionIdx, questionType, recall5, recall10, ndcg10 }, ... ]
const results = {};
for (const mode of MODES) results[mode] = [];

const startTime = performance.now();

// ─── Evaluation loop ────────────────────────────────────────────────────────

for (let qi = 0; qi < questions.length; qi++) {
  const q = questions[qi];
  progressBar(qi, questions.length, startTime);

  const questionText = q.question;
  const questionType = q.question_type || "unknown";
  const sessions = q.haystack_sessions || [];
  const relevantIds = getRelevantSessionIds(q);

  // Skip questions with no ground truth (pure abstention with no answer sessions)
  if (relevantIds.size === 0) {
    for (const mode of MODES) {
      results[mode].push({
        questionIdx: qi,
        questionType,
        recall5: null,
        recall10: null,
        ndcg10: null,
        skipped: true,
      });
    }
    continue;
  }

  // Create fresh in-memory store
  const store = new BenchStore();

  // Ingest sessions as chunks
  const granularity = opts.granularity;
  let chunks;
  if (granularity === "turn") chunks = sessionsToTurnChunks(sessions);
  else if (granularity === "hybrid") chunks = sessionsToHybridChunks(sessions);
  else chunks = sessionsToChunks(sessions);

  // Build O(1) map: chunk ID → session ID (needed for turn and hybrid)
  const needsMapping = granularity === "turn" || granularity === "hybrid";
  const chunkToSession = needsMapping
    ? new Map(chunks.map((c) => [c.id, c.sessionId]))
    : null;

  for (const chunk of chunks) {
    // Non-session granularities: topic identifies role + granularity for BM25 signal
    const topic = granularity === "session"
      ? `Session ${chunk.id}`
      : chunk.granularity === "session"
        ? `Session ${chunk.sessionId}`
        : `Session ${chunk.sessionId} ${chunk.role}`;

    const text = prepareText({ topic, tags: [questionType], content: chunk.content });

    let embedding = null;
    if (needsEmbeddings) {
      embedding = await embed(text);
    }

    store.insertChunk({
      id: chunk.id,
      topic,
      tags: [questionType],
      content: chunk.content,
      embedding,
    });
  }

  // Compute query embedding once (shared across modes)
  let queryEmbedding = null;
  if (needsEmbeddings) {
    queryEmbedding = await embed(questionText);
  }

  // Run search for each mode
  for (const mode of MODES) {
    const hits = store.hybridSearch(questionText, queryEmbedding, opts.topK, mode);
    const retrievedIds = hits.map((h) => h.id);

    // Turn/hybrid: map chunk IDs → session IDs, dedup preserving rank order
    let retrievedSessionIds;
    if (needsMapping) {
      const seen = new Set();
      retrievedSessionIds = [];
      for (const id of retrievedIds) {
        const sessionId = chunkToSession.get(id) ?? id;
        if (!seen.has(sessionId)) {
          seen.add(sessionId);
          retrievedSessionIds.push(sessionId);
        }
      }
    } else {
      retrievedSessionIds = retrievedIds;
    }

    results[mode].push({
      questionIdx: qi,
      questionType,
      recall5: recallAtK(retrievedSessionIds, relevantIds, 5),
      recall10: recallAtK(retrievedSessionIds, relevantIds, 10),
      ndcg10: ndcgAtK(retrievedSessionIds, relevantIds, 10),
    });
  }

  store.destroy();
}

progressBar(questions.length, questions.length, startTime);
process.stderr.write("\n\n");

const totalTime = ((performance.now() - startTime) / 1000).toFixed(1);

// ─── Aggregate results ──────────────────────────────────────────────────────

function aggregate(entries) {
  const valid = entries.filter((e) => e.recall5 !== null);
  if (valid.length === 0) return { recall5: 0, recall10: 0, ndcg10: 0, count: 0 };
  return {
    recall5: valid.reduce((s, e) => s + e.recall5, 0) / valid.length,
    recall10: valid.reduce((s, e) => s + e.recall10, 0) / valid.length,
    ndcg10: valid.reduce((s, e) => s + e.ndcg10, 0) / valid.length,
    count: valid.length,
  };
}

function pct(v) {
  return (v * 100).toFixed(1).padStart(6) + "%";
}

function f3(v) {
  return v.toFixed(3).padStart(7);
}

// ─── Overall results table ──────────────────────────────────────────────────

console.log(`  Mode       | Recall@5 | Recall@10 | NDCG@10 | Questions`);
console.log(`  -----------|----------|-----------|---------|----------`);

const overallByMode = {};
for (const mode of MODES) {
  const agg = aggregate(results[mode]);
  overallByMode[mode] = agg;
  console.log(
    `  ${mode.padEnd(10)} | ${pct(agg.recall5)} | ${pct(agg.recall10)}  | ${f3(agg.ndcg10)} | ${agg.count}`,
  );
}

// ─── Per-category breakdown (first mode) ────────────────────────────────────

const primaryMode = MODES[0];
const categories = [...new Set(results[primaryMode].map((r) => r.questionType))].sort();

console.log(`\n  Per-Category Breakdown (${primaryMode}):`);
console.log(`  ${"Category".padEnd(28)} | Count | Recall@5 | Recall@10 | NDCG@10`);
console.log(`  ${"─".repeat(28)}-|-------|----------|-----------|--------`);

const categoryResults = {};
for (const cat of categories) {
  const entries = results[primaryMode].filter((r) => r.questionType === cat);
  const agg = aggregate(entries);
  categoryResults[cat] = agg;
  console.log(
    `  ${cat.padEnd(28)} | ${String(agg.count).padStart(5)} | ${pct(agg.recall5)} | ${pct(agg.recall10)}  | ${f3(agg.ndcg10)}`,
  );
}

// ─── Comparison table ───────────────────────────────────────────────────────

console.log(`\n  Comparison with published systems:`);
console.log(`  ${"System".padEnd(30)} | Recall@5 | LLM Required`);
console.log(`  ${"─".repeat(30)}-|----------|-------------`);

const comparisons = [
  { name: "MemPalace hybrid+LLM", recall5: "100.0%", llm: "Haiku" },
  { name: "MemPalace raw", recall5: " 96.6%", llm: "None" },
  { name: "Supermemory ASMR", recall5: " ~99%", llm: "Yes" },
  { name: "Mastra (GPT-5-mini)", recall5: "94.87%", llm: "Yes" },
  { name: "Hindsight (Gemini-3)", recall5: " 91.4%", llm: "Yes" },
  { name: "Stella (dense)", recall5: "  ~85%", llm: "None" },
  { name: "Contriever", recall5: "  ~78%", llm: "None" },
  { name: "BM25 (sparse)", recall5: "  ~70%", llm: "None" },
];

// Insert our results
for (const mode of MODES) {
  const agg = overallByMode[mode];
  comparisons.push({
    name: `agent-memory-store (${mode})`,
    recall5: pct(agg.recall5),
    llm: "None",
    ours: true,
  });
}

// Sort by recall (ours at bottom for visibility)
const ours = comparisons.filter((c) => c.ours);
const theirs = comparisons.filter((c) => !c.ours);

for (const c of theirs) {
  console.log(`  ${c.name.padEnd(30)} | ${c.recall5.padStart(8)} | ${c.llm}`);
}
console.log(`  ${"─".repeat(30)}-|----------|-------------`);
for (const c of ours) {
  console.log(`  ${c.name.padEnd(30)} | ${c.recall5.padStart(8)} | ${c.llm}  ◀`);
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(65)}`);
console.log(`  Completed in ${totalTime}s`);
console.log(`${"═".repeat(65)}\n`);

// ─── Save JSON results ──────────────────────────────────────────────────────

const cacheDir = path.join(__dirname, ".cache");
mkdirSync(cacheDir, { recursive: true });

const output = {
  meta: {
    date: new Date().toISOString(),
    questions: questions.length,
    granularity: opts.granularity,
    topK: opts.topK,
    embedding: "all-MiniLM-L6-v2",
    totalTimeSeconds: parseFloat(totalTime),
  },
  overall: overallByMode,
  categories: categoryResults,
  perQuestion: results,
};

const outFile = path.join(cacheDir, "longmemeval_results.json");
writeFileSync(outFile, JSON.stringify(output, null, 2));
console.log(`  Results saved to ${outFile}\n`);
