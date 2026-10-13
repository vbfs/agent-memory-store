/**
 * Embedding providers.
 *
 * An Embedder turns text into L2-normalized Float32Array vectors:
 *
 *   interface Embedder {
 *     id: string                 // stored next to each vector; a change triggers re-embedding
 *     dim: number | null         // known after load
 *     load(): Promise<boolean>   // idempotent; false when unavailable
 *     isReady(): boolean
 *     embedQuery(text): Promise<Float32Array>
 *     embedDocuments(texts): Promise<Float32Array[]>
 *   }
 *
 * TransformersEmbedder runs an ONNX model locally via @huggingface/transformers.
 * HashEmbedder is a deterministic, dependency-free embedder used by tests and CI.
 */

import { createHash } from "crypto";
import os from "os";
import path from "path";
import { extractTerms } from "./store/fts-query.js";

/**
 * Supported local models. Prefixes and pooling follow each model card; using
 * the wrong ones silently degrades retrieval quality.
 *
 * duplicateThreshold: cosine above which write_context reports a "possible
 * duplicate". Calibrated on the golden set (12 superseded/superseding pairs vs
 * each memory's nearest unrelated neighbour) for a ~5% false-positive rate.
 */
export const MODELS = {
  "granite-97m-multilingual": {
    repo: "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
    pooling: "cls",
    queryPrefix: "",
    docPrefix: "",
    dtype: "q8",
    duplicateThreshold: 0.89,
  },
  "embeddinggemma-300m": {
    repo: "onnx-community/embeddinggemma-300m-ONNX",
    pooling: "mean",
    queryPrefix: "task: search result | query: ",
    docPrefix: "title: none | text: ",
    dtype: "q8",
    duplicateThreshold: 0.8,
  },
  "arctic-embed-m-v2": {
    repo: "Snowflake/snowflake-arctic-embed-m-v2.0",
    pooling: "cls",
    queryPrefix: "query: ",
    docPrefix: "",
    dtype: "q8",
    duplicateThreshold: 0.65,
  },
  "minilm-l6-en": {
    repo: "Xenova/all-MiniLM-L6-v2",
    pooling: "mean",
    queryPrefix: "",
    docPrefix: "",
    dtype: "q8",
    duplicateThreshold: 0.75,
  },
};

export const DEFAULT_MODEL = "arctic-embed-m-v2";

/** Max characters of a document sent to the model (~512 tokens). */
export const MAX_EMBED_CHARS = 2000;

const BATCH_SIZE = 16;

/**
 * Where models are cached. transformers.js defaults to a folder inside
 * node_modules, which npx and `npm ci` throw away — so pin a user cache.
 */
export function modelCacheDir() {
  if (process.env.AGENT_MEMORY_CACHE) return path.resolve(process.env.AGENT_MEMORY_CACHE);
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "agent-memory-store", "models");
}

function log(msg) {
  process.stderr.write(`[agent-memory-store] ${msg}\n`);
}

export class TransformersEmbedder {
  /**
   * @param {string} name - key of MODELS
   */
  constructor(name) {
    const spec = MODELS[name];
    if (!spec) {
      throw new Error(
        `Unknown embedding model "${name}". Available: ${Object.keys(MODELS).join(", ")}, none`,
      );
    }
    this.name = name;
    this.spec = spec;
    this.id = `${spec.repo}@${spec.dtype}`;
    this.dim = null;
    this.duplicateThreshold = spec.duplicateThreshold;
    this._extractor = null;
    this._loading = null;
    this._failed = false;
  }

  isReady() {
    return this._extractor !== null;
  }

  async load() {
    if (this._extractor) return true;
    if (this._failed) return false;
    if (!this._loading) {
      this._loading = (async () => {
        try {
          log(`Loading embedding model ${this.spec.repo} (downloaded once, then cached)...`);
          const { pipeline, env } = await import("@huggingface/transformers");
          env.cacheDir = modelCacheDir();
          // transformers.js warns that arctic's "gte" architecture is loaded via
          // the base class; that is the intended path, so hide only that line.
          const warn = console.warn;
          console.warn = (...a) => (String(a[0]).startsWith("Unknown model class") ? undefined : warn(...a));
          let extractor;
          try {
            extractor = await pipeline("feature-extraction", this.spec.repo, { dtype: this.spec.dtype });
          } finally {
            console.warn = warn;
          }
          const probe = await extractor(["probe"], {
            pooling: this.spec.pooling,
            normalize: true,
          });
          this.dim = probe.dims.at(-1);
          this._extractor = extractor;
          log(`Embedding model ready (${this.dim} dims).`);
          return true;
        } catch (err) {
          this._failed = true;
          log(`Embedding model failed to load: ${err.message}. Using keyword search only.`);
          return false;
        }
      })();
    }
    return this._loading;
  }

  async _run(texts) {
    if (!(await this.load())) throw new Error("Embedding model unavailable");
    // Batch texts of similar length together: each batch is padded to its
    // longest text, so mixing short and long ones wastes most of the compute.
    const order = texts.map((t, i) => i).sort((a, b) => texts[a].length - texts[b].length);
    const out = new Array(texts.length);
    for (let i = 0; i < order.length; i += BATCH_SIZE) {
      const idx = order.slice(i, i + BATCH_SIZE);
      const tensor = await this._extractor(
        idx.map((k) => texts[k]),
        { pooling: this.spec.pooling, normalize: true },
      );
      const dim = tensor.dims.at(-1);
      idx.forEach((k, j) => {
        out[k] = Float32Array.from(tensor.data.subarray(j * dim, (j + 1) * dim));
      });
    }
    return out;
  }

  async embedQuery(text) {
    const [v] = await this._run([this.spec.queryPrefix + text.slice(0, MAX_EMBED_CHARS)]);
    return v;
  }

  async embedDocuments(texts) {
    return this._run(texts.map((t) => this.spec.docPrefix + t.slice(0, MAX_EMBED_CHARS)));
  }
}

/**
 * Deterministic hashing-trick embedder (terms + character trigrams).
 * Captures lexical overlap only — it exists so tests exercise the full
 * vector path without downloading a model. Not for production use.
 */
export class HashEmbedder {
  constructor(dim = 256) {
    this.id = `hash-v1-${dim}`;
    this.dim = dim;
    this.duplicateThreshold = 0.8;
  }

  isReady() {
    return true;
  }

  async load() {
    return true;
  }

  _vec(text) {
    const v = new Float32Array(this.dim);
    const add = (feature, weight) => {
      const h = createHash("md5").update(feature).digest();
      const idx = h.readUInt32LE(0) % this.dim;
      v[idx] += (h[4] & 1 ? 1 : -1) * weight;
    };
    for (const term of extractTerms(text)) {
      add(`t:${term}`, 1);
      const padded = `#${term}#`;
      for (let i = 0; i + 3 <= padded.length; i++) add(`g:${padded.slice(i, i + 3)}`, 0.3);
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  }

  async embedQuery(text) {
    return this._vec(text);
  }

  async embedDocuments(texts) {
    return texts.map((t) => this._vec(t));
  }
}

/**
 * Creates the embedder named by `name` (or AGENT_MEMORY_MODEL).
 * "none" disables semantic search; "hash" is the test embedder.
 *
 * @param {string} [name]
 * @returns {object|null}
 */
export function createEmbedder(name = process.env.AGENT_MEMORY_MODEL || DEFAULT_MODEL) {
  if (name === "none") return null;
  if (name === "hash") return new HashEmbedder();
  return new TransformersEmbedder(name);
}

/**
 * Text that represents a memory for embedding purposes.
 */
export function documentText({ topic, tags = [], content }) {
  const tagLine = tags.length ? `\n${tags.join(", ")}` : "";
  return `${topic}${tagLine}\n${content}`;
}
