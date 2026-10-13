// Metrics checked against values computed by hand (and, for NDCG, against
// the formula in LongMemEval's official eval_utils.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { recallAny, recallAll, ndcgAny, reciprocalRank, mean, percentile } from "../benchmarks/lib/metrics.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("recall_any / recall_all", () => {
  const ranked = ["a", "b", "c", "d", "e", "f"];
  assert.equal(recallAny(ranked, new Set(["c"]), 5), 1);
  assert.equal(recallAny(ranked, new Set(["f"]), 5), 0);
  assert.equal(recallAll(ranked, new Set(["a", "e"]), 5), 1);
  assert.equal(recallAll(ranked, new Set(["a", "f"]), 5), 0, "f is rank 6");
  assert.equal(recallAny([], new Set(["a"]), 5), 0);
});

test("reciprocal rank", () => {
  assert.equal(reciprocalRank(["x", "a"], new Set(["a"])), 1 / 2);
  assert.equal(reciprocalRank(["a"], new Set(["a"])), 1);
  assert.equal(reciprocalRank(["x", "y"], new Set(["a"])), 0);
  assert.equal(reciprocalRank(["x", "b", "a"], new Set(["a", "b"])), 1 / 2, "first relevant counts");
});

test("ndcg_any matches the official formula", () => {
  // official dcg: rel[0] + sum_{i>=1} rel[i] / log2(i + 1)
  // one gold doc at rank 3 → DCG = 1/log2(3); ideal = 1
  close(ndcgAny(["x", "y", "a"], new Set(["a"]), 1, 10), 1 / Math.log2(3));
  // two gold at ranks 1 and 3 → (1 + 1/log2(3)) / (1 + 1/log2(2))
  close(ndcgAny(["a", "x", "b"], new Set(["a", "b"]), 2, 10), (1 + 1 / Math.log2(3)) / 2);
  // gold outside the cutoff
  close(ndcgAny(["x", "y", "a"], new Set(["a"]), 1, 2), 0);
  close(ndcgAny(["a"], new Set(["a"]), 1, 10), 1);
});

test("mean and nearest-rank percentile", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(mean([]), 0);
  assert.equal(percentile([5, 1, 4, 2, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});
