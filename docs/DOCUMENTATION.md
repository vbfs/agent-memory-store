# agent-memory-store — Reference

- [1. Concepts](#1-concepts)
- [2. Tools](#2-tools)
- [3. Search and ranking](#3-search-and-ranking)
- [4. Many agents, one store](#4-many-agents-one-store)
- [5. Embedding models](#5-embedding-models)
- [6. Configuration](#6-configuration)
- [7. Storage, schema and migrations](#7-storage-schema-and-migrations)
- [8. Programmatic use](#8-programmatic-use)
- [9. Benchmarks and how to reproduce them](#9-benchmarks-and-how-to-reproduce-them)
- [10. Limits and trade-offs](#10-limits-and-trade-offs)
- [11. Troubleshooting](#11-troubleshooting)

---

## 1. Concepts

**Memory** — a short, self-contained piece of knowledge an agent wants others to
find later: a decision and its rationale, an output and where it lives, a
discovery. Fields:

| Field | Description |
| --- | --- |
| `id` | Generated 12-hex id, or a stable id you choose (`auth-decision`). |
| `topic` | Specific title. Weighted 3× in keyword search. |
| `content` | Markdown body. |
| `tags` | Lowercase labels, matched exactly. Weighted 2× in keyword search. |
| `agent` | Agent that created it. `updated_by` tracks the last writer. |
| `importance` | `low` / `medium` / `high` / `critical`. Breaks near-ties in ranking. |
| `version` | Starts at 1, +1 on every update. Used for compare-and-set. |
| `created_at`, `updated_at` | ISO 8601. |
| `expires_at` | Set by `ttl_days`. Expired memories are invisible immediately and deleted within a minute. |

**State** — a key → JSON value map for small mutable coordination data (current
phase, run id, owner of a task, counters). Every key has a `version`.

Rule of thumb: if another agent should *find* it, it is a memory; if another
agent should *read a known key*, it is state.

---

## 2. Tools

All tools return plain text designed to be short and readable by a model.
Failures return `isError: true` with an actionable message (validation errors,
version conflicts, refused secrets, unknown ids) — never a stack trace.

### `search_context` (read-only)

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `query` | string | — | Natural language, any language, or exact identifiers. Punctuation is safe. |
| `tags` | string[] | — | At least one must match (exact, case-insensitive). |
| `agent` | string | — | Creator agent id. |
| `since` / `until` | ISO date | — | Filter on `updated_at`. |
| `top_k` | 1–50 | 6 | |
| `min_score` | 0–1 | 0 | Drops results below this rank-based score. |
| `search_mode` | `hybrid` \| `bm25` \| `semantic` | `hybrid` | Falls back to `bm25` while the model loads or if it is unavailable; the response says which mode ran. |
| `max_chars` | 100–20000 | 1000 | Content shown per result; longer content is cut with a pointer to `read_context`. |

Example response:

```
2 result(s), hybrid search:

[1] Auth — chose JWT over sessions
id: 3f9a0c12be41 · score 0.98 · similarity 0.81 · tags: auth, decision · critical · by backend-agent · updated 2026-09-30 (v2)
Stateless JWT (RS256). Refresh tokens in Redis, 7d TTL. ...
```

### `write_context`

| Param | Type | Notes |
| --- | --- | --- |
| `topic` | string | Required. |
| `content` | string | Required. |
| `id` | string | Update this memory in place, or create it with this id. `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. |
| `tags` | string[] | Normalized to lowercase, deduplicated. On update, omitted = keep. |
| `importance` | enum | On update, omitted = keep. Default `medium`. |
| `agent` | string | Defaults to `AGENT_MEMORY_AGENT` or `global`. |
| `ttl_days` | number \| null | Omitted = keep current expiry; `null` = never expire. |
| `expected_version` | integer | Write only if the current version matches (`0` = must not exist). |

The response reports `Created`/`Updated`, the new version, and up to three
**possible duplicates**: memories with the same topic (case-insensitive) or
semantic similarity above the model's duplicate threshold. Content that looks
like a credential is refused (see [§10](#10-limits-and-trade-offs)).

### `read_context` (read-only)

`id` → full content and metadata. Unknown or expired ids are errors.

### `list_context` (read-only)

Newest first, metadata only (with content length). Filters: `agent`, `tags`,
`since`, `until`. Paging: `limit` (1–500, default 50), `offset`. The response
states the total and the next offset.

### `delete_context` (destructive)

`id` → deletes the memory, its vector and its index entries. Unknown ids are errors.

### `get_state` (read-only) / `set_state`

`get_state(key)` returns the value, version, time and writer (or "not set,
version 0"). `set_state(key, value, expected_version?, agent?)` stores any JSON
value; with `expected_version` it is a compare-and-set:

```
get_state("release_owner")                                       → not set (version 0)
set_state("release_owner", "infra-agent", expected_version: 0)    → version 1   (claimed)
set_state("release_owner", "qa-agent",    expected_version: 0)    → error: conflict (already claimed)
```

---

## 3. Search and ranking

1. **Keyword (BM25)** — SQLite FTS5 with the `unicode61 remove_diacritics 2`
   tokenizer, so `decisao` matches `Decisão`. The query is split into terms
   (Unicode-aware), common Portuguese/English stopwords are dropped, and each
   term is quoted, so no input can produce an FTS syntax error. Columns are
   weighted topic 3 : tags 2 : content 1.
2. **Semantic** — the query is embedded with the configured local model and
   compared (cosine) with every memory vector in an in-memory index. Filters
   (`agent`, `tags`, dates, expiry) are applied before ranking.
3. **Fusion** — Reciprocal Rank Fusion over the top 50 of each list
   (`1 / (60 + rank)`, equal weights). `score` is that sum divided by its
   maximum, so `1.0` means "first in both lists" and `0.5` "first in one list
   only". It is a relative ranking signal, not a probability.
4. **Tie-breakers** — importance and recency (30-day half-life) add at most
   ~2.5×10⁻⁴, less than one rank step at the top of the list, so they only
   reorder results that are otherwise nearly tied.

`similarity` (cosine) is reported for results found by semantic search. It is
absolute but model-specific: compare it across results of one query, not
across models.

---

## 4. Many agents, one store

Each MCP client starts its own server process; all of them open the same
`store.db`. This is safe:

- **WAL mode** — readers never block writers or each other.
- **`busy_timeout = 5000` and `BEGIN IMMEDIATE`** — concurrent writers queue
  instead of failing with `SQLITE_BUSY`.
- **Versions** — `expected_version` on `write_context` and `set_state` gives
  agents compare-and-set, so they never silently overwrite each other.
- **Vector index sync** — each process keeps its own in-memory index and
  checks `PRAGMA data_version` before searching; changes from other processes
  are loaded incrementally (new vectors by sequence number, deletions by
  count reconciliation).
- **Embedding work** — vectors are computed on write when the model is ready,
  otherwise in the background. Background and re-embedding work is guarded by
  a lease so only one process does it, and a vector is stored only if the
  memory's content hash still matches (an older embedding can never overwrite
  a newer one).

The test suite runs 4 processes × 500 writes plus a contended compare-and-set
counter against one file and checks that nothing is lost.

Every process loads its own copy of the model (see the RAM figure in the
README's performance table). All agents sharing a store must use the same
`AGENT_MEMORY_MODEL`; otherwise they keep re-embedding each other's vectors.

---

## 5. Embedding models

Models run locally on CPU via ONNX Runtime (`@huggingface/transformers`), 8-bit
quantized. They are downloaded once to `~/.cache/agent-memory-store/models`.

| Key (`AGENT_MEMORY_MODEL`) | Model | Languages | Dims | Notes |
| --- | --- | --- | --- | --- |
| `arctic-embed-m-v2` | `Snowflake/snowflake-arctic-embed-m-v2.0` | multilingual | 768 | **Default.** Apache-2.0. ~310 MB download, ~630 MB RAM per process. |
| `granite-97m-multilingual` | `ibm-granite/granite-embedding-97m-multilingual-r2` | multilingual | 384 | Apache-2.0. Lighter (~450 MB RAM), lower quality. |
| `embeddinggemma-300m` | `google/embeddinggemma-300m` | multilingual | 768 | Gemma license. Same quality as the default, ~7× slower, ~1.4 GB RAM. |
| `minilm-l6-en` | `sentence-transformers/all-MiniLM-L6-v2` | English | 384 | The 0.0.x model. Fails cross-lingual queries. |
| `none` | — | — | — | Keyword search only, ~64 MB RAM. |

The default was chosen by measurement — see the README's results table and
`benchmarks/results/`. Each model's query/document prefixes and pooling follow
its model card. Documents are embedded as `topic + tags + content`, truncated to
2000 characters (~512 tokens); keyword search always covers the full text.

Switching models is automatic: vectors are stored with the model id, and on
start the server re-embeds every memory that has no vector for the current
model, in the background. Search falls back to keyword-only until that
finishes.

---

## 6. Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_STORE_PATH` | `./.agent-memory-store` (relative to the client's working directory) | Store directory. Use an absolute path to share one store across repositories. |
| `AGENT_MEMORY_MODEL` | `arctic-embed-m-v2` | Embedding model key (§5) or `none`. |
| `AGENT_MEMORY_AGENT` | `global` | Default agent id for writes from this server process. Set one per agent for provenance. |
| `AGENT_MEMORY_CACHE` | `$XDG_CACHE_HOME/agent-memory-store/models` or `~/.cache/agent-memory-store/models` | Model cache directory. |

---

## 7. Storage, schema and migrations

One SQLite file, `store.db` (plus `-wal`/`-shm` while open):

| Table | Purpose |
| --- | --- |
| `chunks` | Memories. `seq INTEGER PRIMARY KEY` keeps FTS rowids stable across `VACUUM`. |
| `chunks_fts` | FTS5 external-content index, kept in sync by triggers. |
| `vectors` | One vector per memory: model id, content hash, Float32 blob. Deleted with the memory (foreign key cascade). |
| `state` | Key → JSON value, version, writer. |
| `leases` | Short-lived locks for background embedding work. |

The schema version lives in `PRAGMA user_version` (currently 2). On start the
server migrates older stores in a single transaction:

- **0.0.6–0.0.9 SQLite stores (v1)** — rebuilds the tables and FTS index,
  keeps every memory and state value with their timestamps, drops the old
  MiniLM vectors (recomputed with the current model).
- **≤ 0.0.5 markdown stores** (`chunks/*.md`, `state/*.json`) — imported, then
  the folders are renamed to `*_backup`.

Backup: copy `store.db` while no agent is writing, or run
`sqlite3 store.db "VACUUM INTO 'backup.db'"` at any time.

---

## 8. Programmatic use

```js
import { MemoryStore } from "agent-memory-store";
import { createEmbedder } from "agent-memory-store/embeddings";

const store = MemoryStore.open("/path/to/store.db", { embedder: createEmbedder() });
const m = await store.write({ topic: "Deploy", content: "Blue-green on ECS", tags: ["infra"] });
const { mode, results } = await store.search({ query: "how do we deploy?", limit: 5 });
store.setState("phase", "release", { expectedVersion: 0 });
store.close();
```

`createEmbedder("none")` gives a keyword-only store; `createEmbedder("hash")`
is a deterministic test embedder with no model download.

---

## 9. Benchmarks and how to reproduce them

Every benchmark imports `MemoryStore` — the same code the MCP server runs.
Results are written to `benchmarks/results/*.json` with the machine, Node
version and date.

```bash
npm run bench                            # golden-set quality + speed (2K memories), ~30 s, < 1 GB RAM
npm run bench:golden                     # golden set with per-type / per-language breakdown
npm run bench:tune-fusion                # reproduces the fusion choice (dev/test split)
npm run bench:longmemeval                # LongMemEval-S, official protocol — heavy (≈1 h, several GB)
node benchmarks/longmemeval.js --model none   # keyword-only LongMemEval, seconds
```

Benchmarks cache embeddings in `benchmarks/.cache/embeddings/` (vectors are
deterministic, so results are identical); re-runs only pay for new texts.

**Golden set** (`benchmarks/golden/dataset.json`): 150 hand-written memories
from a fictional product team (≈55% Portuguese, 45% English) and 120 queries:
cross-lingual, paraphrases, exact identifiers, knowledge updates (the newer
memory must win), filtered queries and multi-memory questions. It is synthetic
and small; treat it as a regression test for the intended workload, not as a
leaderboard.

**LongMemEval-S** (Wu et al., ICLR 2025): ~50 chat sessions per question.
Protocol copied from the official retrieval code: session granularity, user
turns only, abstention questions and questions without user-side evidence
excluded (419 of 500 in the cleaned release), `recall_any@k`, `recall_all@k`
and `ndcg_any@k`. `--with-assistant` indexes assistant turns too and is
reported separately because it is not the official setting. LongMemEval
indexes raw conversations, not curated memories, so it measures the retrieval
engine, not the intended usage.

---

## 10. Limits and trade-offs

- **Scale** — exact vector search is linear in the number of memories. It is
  fast at agent-memory scale (see README); beyond ~100K memories per store,
  split stores by domain or use keyword-only mode.
- **RAM per process** — each agent process holds the model and its own copy of
  the vector index.
- **Long content** — only the first ~2000 characters are embedded. Keyword
  search covers everything. Prefer several focused memories over one long one.
- **Secret detection** is pattern-based (private keys, cloud/API key formats,
  JWTs, passwords inside connection strings). It catches common mistakes; it
  is not a DLP system.
- **No access control** — anyone who can read `store.db` can read every memory.
  The store is meant for one team on one machine.
- **Scores** — `score` is a relative rank signal; there is no universal "is
  this relevant" threshold. Read the top results.

---

## 11. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Responses say `bm25 search` right after start | The model is loading (first run downloads it). It switches to hybrid automatically. |
| `Embedding model failed to load` on stderr | No network on first run or a corrupt cache. Delete `~/.cache/agent-memory-store/models` and restart, or set `AGENT_MEMORY_MODEL=none`. |
| Memory missing from another project | `AGENT_STORE_PATH` defaults to the client's working directory, so each project has its own store. Set an absolute path to share one. |
| `Version conflict` | Another agent changed it first. Re-read (`read_context` / `get_state`) and retry with the new version. |
| `Refused: content looks like it contains a …` | Store where the secret lives, not its value. |
| `node:sqlite` not found | Node.js older than 22.13. Upgrade. |
