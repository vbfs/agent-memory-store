/**
 * In-memory exact vector index.
 *
 * Vectors live in one contiguous Float32Array so a query is a single tight
 * loop of dot products (vectors are L2-normalized, so dot = cosine). Exact
 * search over 100K × 384 dims takes tens of milliseconds and needs no native
 * extension; agent memory stores rarely get near that size.
 */

export class VectorIndex {
  constructor() {
    this.dim = 0;
    this.size = 0;
    this.matrix = new Float32Array(0);
    /** @type {string[]} position → chunk id */
    this.ids = [];
    /** @type {Map<string, number>} chunk id → position */
    this.pos = new Map();
  }

  clear() {
    this.size = 0;
    this.ids = [];
    this.pos = new Map();
    this.matrix = new Float32Array(this.dim * 64);
  }

  _ensureCapacity(n) {
    const needed = n * this.dim;
    if (this.matrix.length >= needed) return;
    let cap = Math.max(64 * this.dim, this.matrix.length);
    while (cap < needed) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.matrix.subarray(0, this.size * this.dim));
    this.matrix = next;
  }

  /**
   * Inserts or replaces the vector for a chunk.
   * @param {string} id
   * @param {Float32Array} vec
   */
  upsert(id, vec) {
    if (this.dim === 0) {
      this.dim = vec.length;
      this.clear();
    }
    if (vec.length !== this.dim) {
      throw new Error(`Vector dim ${vec.length} does not match index dim ${this.dim}`);
    }
    let p = this.pos.get(id);
    if (p === undefined) {
      this._ensureCapacity(this.size + 1);
      p = this.size++;
      this.ids[p] = id;
      this.pos.set(id, p);
    }
    this.matrix.set(vec, p * this.dim);
  }

  /**
   * Removes a chunk's vector (swap-with-last, O(dim)).
   * @param {string} id
   */
  remove(id) {
    const p = this.pos.get(id);
    if (p === undefined) return;
    const last = this.size - 1;
    if (p !== last) {
      const lastId = this.ids[last];
      this.matrix.copyWithin(p * this.dim, last * this.dim, (last + 1) * this.dim);
      this.ids[p] = lastId;
      this.pos.set(lastId, p);
    }
    this.ids.length = last;
    this.pos.delete(id);
    this.size = last;
  }

  has(id) {
    return this.pos.has(id);
  }

  /**
   * Returns the k most similar chunks.
   *
   * @param {Float32Array} query - normalized query vector
   * @param {number} k
   * @param {Set<string>|null} [allowed] - restrict to these chunk ids
   * @returns {Array<{ id: string, score: number }>} sorted by score desc
   */
  search(query, k, allowed = null) {
    if (this.size === 0 || k <= 0) return [];
    if (query.length !== this.dim) {
      throw new Error(`Query dim ${query.length} does not match index dim ${this.dim}`);
    }
    const dim = this.dim;
    const m = this.matrix;
    // Top-k kept as a small array sorted ascending by score (k is ≤ ~100).
    const topScores = [];
    const topPos = [];

    for (let p = 0; p < this.size; p++) {
      if (allowed && !allowed.has(this.ids[p])) continue;
      let dot = 0;
      const base = p * dim;
      for (let i = 0; i < dim; i++) dot += query[i] * m[base + i];

      if (topScores.length < k) {
        let j = topScores.length;
        while (j > 0 && topScores[j - 1] > dot) j--;
        topScores.splice(j, 0, dot);
        topPos.splice(j, 0, p);
      } else if (dot > topScores[0]) {
        let j = 1;
        while (j < k && topScores[j] < dot) j++;
        topScores.splice(j, 0, dot);
        topPos.splice(j, 0, p);
        topScores.shift();
        topPos.shift();
      }
    }

    const out = [];
    for (let j = topScores.length - 1; j >= 0; j--) {
      out.push({ id: this.ids[topPos[j]], score: topScores[j] });
    }
    return out;
  }
}
