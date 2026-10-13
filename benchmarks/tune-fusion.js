#!/usr/bin/env node
/**
 * Reproduces how DEFAULT_FUSION was chosen: grid over fusion method and
 * semantic weight on the golden set, split into a dev half (odd queries,
 * used for the choice) and a test half (even queries, reported only).
 *
 * Usage: node benchmarks/tune-fusion.js [model ...]
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MemoryStore } from "../src/store/memory-store.js";
import { createEmbedder } from "../src/embeddings.js";
import { withCache } from "./lib/cached-embedder.js";
import { reciprocalRank, recallAny, mean } from "./lib/metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(path.join(__dirname, "golden", "dataset.json"), "utf8"));
const DAY = 86_400_000;
const NOW = Date.parse("2026-06-01T12:00:00Z");

const configs = [];
for (const method of ["rrf", "convex"]) {
  for (const w of [0.3, 0.5, 0.6, 0.7, 0.8, 0.9]) configs.push({ method, semanticWeight: w });
}
configs.push({ method: "rrf", semanticWeight: 1 }); // semantic only

const models = process.argv.slice(2);
if (!models.length) models.push("granite-97m-multilingual", "arctic-embed-m-v2", "embeddinggemma-300m");

for (const model of models) {
  const embedder = withCache(createEmbedder(model));
  if (!(await embedder.load())) throw new Error(`Model ${model} failed to load`);
  let now = NOW;
  const store = MemoryStore.open(":memory:", { embedder, clock: () => now });
  for (const m of [...data.memories].sort((a, b) => b.created_days_ago - a.created_days_ago)) {
    now = NOW - m.created_days_ago * DAY;
    await store.write({ id: m.id, topic: m.topic, content: m.content, tags: m.tags, agent: m.agent, importance: m.importance });
  }
  now = NOW;
  await store.flushEmbeddings();

  console.log(`\n${embedder.id}`);
  console.log("fusion              | MRR dev | MRR test | R@5 dev | R@5 test");
  for (const fusion of configs) {
    const split = { dev: [], test: [] };
    for (let i = 0; i < data.queries.length; i++) {
      const q = data.queries[i];
      const { results } = await store.search({ query: q.query, limit: 10, tags: q.filters?.tags, agent: q.filters?.agent, fusion });
      const ranked = results.map((r) => r.id);
      const gold = new Set(q.relevant);
      (i % 2 ? split.dev : split.test).push([reciprocalRank(ranked, gold), recallAny(ranked, gold, 5)]);
    }
    const f = (xs, j) => mean(xs.map((x) => x[j])).toFixed(3);
    const label = fusion.semanticWeight === 1 ? "semantic only" : `${fusion.method} w_sem=${fusion.semanticWeight}`;
    console.log(`${label.padEnd(19)} |  ${f(split.dev, 0)}  |  ${f(split.test, 0)}   |  ${f(split.dev, 1)}  |  ${f(split.test, 1)}`);
  }
  store.close();
}
