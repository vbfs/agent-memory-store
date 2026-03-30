/**
 * Local embedding generation via @huggingface/transformers.
 *
 * Uses the all-MiniLM-L6-v2 model (384 dimensions) running locally via ONNX Runtime.
 * Model is auto-downloaded (~23MB) on first use and cached in ~/.cache/huggingface/.
 *
 * Graceful degradation: if the model fails to load, all functions return null
 * and the system falls back to BM25-only search.
 */

let pipelineInstance = null;
let loadFailed = false;
let loadingPromise = null;

/**
 * Lazily initializes the feature-extraction pipeline.
 * Returns null if the model cannot be loaded.
 * Ensures only one load attempt runs at a time.
 */
async function getPipeline() {
  if (pipelineInstance) return pipelineInstance;
  if (loadFailed) return null;

  // Deduplicate concurrent load attempts
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      process.stderr.write(
        "[agent-memory-store] Loading embedding model (first run downloads ~23MB)...\n",
      );
      const { pipeline } = await import("@huggingface/transformers");
      pipelineInstance = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
        { dtype: "fp32" },
      );
      process.stderr.write(
        "[agent-memory-store] Embedding model loaded successfully.\n",
      );
      return pipelineInstance;
    } catch (err) {
      loadFailed = true;
      process.stderr.write(
        `[agent-memory-store] Embedding model failed to load: ${err.message}\n` +
          `[agent-memory-store] Falling back to BM25-only search.\n`,
      );
      return null;
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

/**
 * Generates an embedding for a single text string.
 *
 * @param {string} text - Text to embed (topic + tags + content)
 * @returns {Promise<Float32Array|null>} 384-dim embedding or null if unavailable
 */
export async function embed(text) {
  const extractor = await getPipeline();
  if (!extractor) return null;

  try {
    const output = await extractor(text, {
      pooling: "mean",
      normalize: true,
    });
    return new Float32Array(output.data);
  } catch (err) {
    process.stderr.write(
      `[agent-memory-store] Embedding error: ${err.message}\n`,
    );
    return null;
  }
}

/**
 * Generates embeddings for multiple texts.
 *
 * @param {string[]} texts
 * @returns {Promise<Array<Float32Array|null>>}
 */
export async function embedBatch(texts) {
  const results = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

/**
 * Prepares searchable text from chunk fields for embedding.
 *
 * @param {object} chunk
 * @param {string} chunk.topic
 * @param {string[]|string} chunk.tags
 * @param {string} chunk.content
 * @returns {string}
 */
export function prepareText({ topic, tags, content }) {
  const tagStr = Array.isArray(tags) ? tags.join(" ") : tags || "";
  // Truncate content to ~800 chars to stay within model token limit
  const truncated = content.length > 800 ? content.slice(0, 800) : content;
  return `${topic} ${tagStr} ${truncated}`.trim();
}

/**
 * Returns whether the embedding model is available.
 */
export function isEmbeddingAvailable() {
  return pipelineInstance !== null && !loadFailed;
}

/**
 * Pre-warms the embedding model (call during startup).
 * Non-blocking — failures are silently handled.
 */
export async function warmup() {
  await getPipeline();
}
