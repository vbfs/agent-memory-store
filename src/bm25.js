/**
 * BM25 (Best Match 25) ranking algorithm — pure JavaScript implementation.
 *
 * BM25 is a bag-of-words retrieval function that ranks documents by relevance
 * to a given query. It is the default ranking algorithm in Elasticsearch and
 * Apache Lucene, and works exceptionally well for short, well-labeled text
 * chunks without requiring any external APIs or embedding models.
 *
 * Tuning parameters:
 *   k1 (1.5) — term frequency saturation. Higher = more weight on rare terms.
 *   b  (0.75) — length normalization. 1.0 = full normalization, 0 = none.
 */

const k1 = 1.5;
const b = 0.75;

/**
 * Tokenizes a string into lowercase terms, stripping punctuation.
 * Handles Latin extended characters (Portuguese, Spanish, French, etc.).
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export class BM25 {
  constructor() {
    /** @type {Array<{ id: string, len: number, metadata: object }>} */
    this.documents = [];
    /** @type {Array<Map<string, number>>} */
    this.termFreqs = [];
    /** @type {Map<string, number>} term → document frequency */
    this.docFreqs = new Map();
    this.avgLen = 0;
  }

  /**
   * Adds a document to the index.
   *
   * @param {string} id       - Unique document identifier
   * @param {string} text     - Searchable text content
   * @param {object} metadata - Arbitrary metadata attached to results
   */
  addDocument(id, text, metadata = {}) {
    const tokens = tokenize(text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

    this.documents.push({ id, len: tokens.length, metadata });
    this.termFreqs.push(tf);

    for (const term of tf.keys()) {
      this.docFreqs.set(term, (this.docFreqs.get(term) || 0) + 1);
    }

    const total = this.documents.reduce((s, d) => s + d.len, 0);
    this.avgLen = total / this.documents.length;
  }

  /**
   * Computes the BM25 score for a single document against query terms.
   *
   * @param {number}   docIdx
   * @param {string[]} queryTerms
   * @returns {number}
   */
  _score(docIdx, queryTerms) {
    const doc = this.documents[docIdx];
    const tf = this.termFreqs[docIdx];
    const N = this.documents.length;
    let score = 0;

    for (const term of queryTerms) {
      const freq = tf.get(term) || 0;
      if (freq === 0) continue;
      const df = this.docFreqs.get(term) || 0;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      const tfNorm =
        (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (doc.len / this.avgLen)));
      score += idf * tfNorm;
    }
    return score;
  }

  /**
   * Searches the index and returns the top-K most relevant documents.
   *
   * @param {string}   query         - Natural language search query
   * @param {number}   [topK=5]      - Maximum results to return
   * @param {Function} [filter=null] - Optional predicate fn(metadata) => boolean
   * @returns {Array<{ id: string, score: number, metadata: object }>}
   */
  search(query, topK = 5, filter = null) {
    const queryTerms = tokenize(query);
    const results = [];

    for (let i = 0; i < this.documents.length; i++) {
      const doc = this.documents[i];
      if (filter && !filter(doc.metadata)) continue;
      const score = this._score(i, queryTerms);
      if (score > 0)
        results.push({ id: doc.id, score, metadata: doc.metadata });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}
