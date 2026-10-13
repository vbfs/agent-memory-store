/**
 * Disk cache for benchmark embeddings.
 *
 * Wraps a real embedder and stores every vector it computes, keyed by a hash
 * of the exact input text, in benchmarks/.cache/embeddings/<model>.bin.
 * Embeddings are deterministic, so cached and fresh vectors are identical;
 * the store, ranking and fusion code under test are unchanged. Re-runs (other
 * fusion settings, CI) then cost seconds instead of an hour.
 */

import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".cache", "embeddings");
const HASH_BYTES = 16;

const key = (kind, text) => createHash("sha256").update(kind).update("\0").update(text).digest().subarray(0, HASH_BYTES);

export class CachedEmbedder {
  constructor(inner) {
    this.inner = inner;
    this.id = inner.id;
    this.duplicateThreshold = inner.duplicateThreshold;
    this.file = path.join(DIR, `${inner.id.replace(/[^\w.-]+/g, "_")}.bin`);
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get dim() {
    return this.inner.dim;
  }

  isReady() {
    return this.inner.isReady();
  }

  async load() {
    if (!(await this.inner.load())) return false;
    if (this.cache.size === 0 && existsSync(this.file)) {
      const buf = readFileSync(this.file);
      const rec = HASH_BYTES + this.inner.dim * 4;
      for (let o = 0; o + rec <= buf.length; o += rec) {
        const vec = new Float32Array(buf.buffer.slice(buf.byteOffset + o + HASH_BYTES, buf.byteOffset + o + rec));
        this.cache.set(buf.toString("hex", o, o + HASH_BYTES), vec);
      }
    }
    return true;
  }

  async _get(kind, texts, compute) {
    const keys = texts.map((t) => key(kind, t));
    const out = keys.map((k) => this.cache.get(k.toString("hex")) ?? null);
    const missing = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    this.hits += texts.length - missing.length;
    this.misses += missing.length;
    if (missing.length) {
      const vecs = await compute(missing.map((i) => texts[i]));
      mkdirSync(DIR, { recursive: true });
      const chunks = [];
      missing.forEach((i, j) => {
        out[i] = vecs[j];
        this.cache.set(keys[i].toString("hex"), vecs[j]);
        chunks.push(keys[i], Buffer.from(vecs[j].buffer, vecs[j].byteOffset, vecs[j].byteLength));
      });
      appendFileSync(this.file, Buffer.concat(chunks));
    }
    return out;
  }

  async embedQuery(text) {
    const [v] = await this._get("q", [text], async ([t]) => [await this.inner.embedQuery(t)]);
    return v;
  }

  async embedDocuments(texts) {
    return this._get("d", texts, (ts) => this.inner.embedDocuments(ts));
  }
}

/** Wraps an embedder with the disk cache unless AMS_NO_EMBED_CACHE=1 (or no embedder). */
export function withCache(embedder) {
  if (!embedder || process.env.AMS_NO_EMBED_CACHE === "1") return embedder;
  return new CachedEmbedder(embedder);
}
