# agent-memory-store

[![npm version](https://img.shields.io/npm/v/agent-memory-store.svg)](https://www.npmjs.com/package/agent-memory-store)
[![npm downloads](https://img.shields.io/npm/dm/agent-memory-store.svg)](https://www.npmjs.com/package/agent-memory-store)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.5-green.svg)](https://nodejs.org)

> 92.1% Recall@5 on LongMemEval — without any LLM calls. Persistent, searchable memory for multi-agent AI systems, powered by SQLite and local embeddings. Zero configuration. Zero external services.

<details>
<summary><strong>Competitive retrieval quality — no LLM overhead</strong></summary>

| System | Recall@5 | LLM Required |
| --- | --- | --- |
| MemPalace hybrid+LLM | 100.0% | Haiku |
| MemPalace raw | 96.6% | None |
| Mastra (GPT-4o-mini) | 94.87% | Yes |
| **agent-memory-store (hybrid)** | **92.1%** | **None** |
| Hindsight (Gemini) | 91.4% | Yes |
| Stella (dense baseline) | ~85% | None |

Outperforms LLM-assisted Hindsight. Within 4.7 points of Mastra — with no API calls. Full benchmark details [below](#longmemeval-benchmark).

</details>

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [How agents use memory](#how-agents-use-memory)
- [Features](#features)
- [Quick start in 60 seconds](#quick-start-in-60-seconds)
- [Configuration](#configuration)
- [Teach your agent to use memory](#teach-your-agent-to-use-memory)
- [Tools](#tools)
- [Architecture](#architecture)
- [Performance](#performance)
- [LongMemEval Benchmark](#longmemeval-benchmark)
- [Documentation](#documentation)
- [Development](#development)
- [License](#license)

---

## Why this exists

Every time you start a new session with Claude Code, Cursor, or any MCP-compatible agent, it starts from zero. It doesn't know your project uses Fastify instead of Express. It doesn't know you decided on JWT two weeks ago. It doesn't know the staging deploy is on ECS.

`agent-memory-store` gives agents a shared, searchable memory that survives across sessions. Agents write what they learn, search what they need, and build on each other's work — just like a team with good documentation, except it happens automatically.

`agent-memory-store` is that shared memory. Agents write what they learn, search what they need, and build on each other's work — across sessions, across agents, without any orchestration overhead.

---

Agents read and write **chunks** through MCP tools. Search combines **BM25 ranking** (via SQLite FTS5) with **semantic vector similarity** (via local embeddings), merged through Reciprocal Rank Fusion for best-of-both-worlds retrieval.

```
                 ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
                 │   Agent A   │   │   Agent B   │   │   Agent C   │
                 └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
                        │                 │                  │
                        └────────────────┬──────────────────┘
                                         │  MCP tools
                              ┌──────────▼──────────┐
                              │  agent-memory-store  │
                              │  hybrid search       │
                              │  BM25 + semantic     │
                              └──────────┬──────────┘
                                         │
                              ┌──────────▼──────────┐
                              │  .agent-memory-store/ │
                              │  └── store.db         │
                              └───────────────────────┘
```

---

## How agents use memory

Every agent action follows the same loop:

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                      AGENT MEMORY LOOP                           │
  │                                                                  │
  │  ┌──────────┐   search_context    ┌──────────────────────────┐  │
  │  │  New     │  ────────────────►  │  Memory store (store.db) │  │
  │  │  task    │  ◄────────────────  │  prior decisions/outputs │  │
  │  └──────────┘   prior context     └──────────────────────────┘  │
  │       │                                                          │
  │       ▼                                                          │
  │  ┌──────────┐                                                    │
  │  │   Act    │  (generate, decide, build)                         │
  │  └──────────┘                                                    │
  │       │                                                          │
  │       ▼                                                          │
  │  ┌──────────┐   write_context     ┌──────────────────────────┐  │
  │  │  Result  │  ────────────────►  │  Memory store (store.db) │  │
  │  │          │                     │  persisted for future    │  │
  │  └──────────┘                     └──────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────┘

  Multi-agent handoff:

  Agent A ──write_context──► store.db ◄──search_context──  Agent B
          ──set_state──────► store.db ◄──get_state───────
          ── HANDOFF message (lightweight pointer) ──────►
```

---

## Features

- **Zero-install usage** via `npx`
- **Hybrid search** — BM25 full-text (FTS5) + semantic vector similarity + Reciprocal Rank Fusion
- **SQLite-backed** — single `store.db` file, WAL mode, native performance
- **Local embeddings** — 384-dim vectors via `all-MiniLM-L6-v2`, no API keys needed
- **Tag and agent filtering** — find chunks by who wrote them or what they cover
- **TTL-based expiry** — chunks auto-delete after a configurable number of days
- **Session state** — key/value store for pipeline progress, flags, and counters
- **Pagination support** — `list_context` supports limit/offset for large stores
- **MCP-native** — works with Claude Code, opencode, Cursor, and any MCP-compatible client
- **Zero external database dependencies** — uses Node.js built-in SQLite (`node:sqlite`)
- **Automatic migration** — upgrades legacy filesystem stores to SQLite on first run

## Requirements

- Node.js >= 22.5 (required for native `node:sqlite` with FTS5 support)

---

## Quick start in 60 seconds

No installation. No account. No API key. One command:

```bash
npx agent-memory-store
```

By default, memory is stored in `.agent-memory-store/store.db` inside the directory where the server starts — so each project gets its own isolated store automatically.

The first run downloads the embedding model (~23MB) once and caches it at `~/.cache/huggingface/`. Every subsequent start is instant.

To use a custom path:

```bash
AGENT_STORE_PATH=/your/project/.agent-memory-store npx agent-memory-store
```

---

## Configuration

### Claude Code

Add to your project's `claude.mcp.json` (or `~/.claude/claude.mcp.json` for global):

```json
{
  "mcpServers": {
    "agent-memory-store": {
      "command": "npx",
      "args": ["-y", "agent-memory-store"]
    }
  }
}
```

Or using the Claude Code CLI:

```bash
claude mcp add agent-memory-store --command "npx" --args "-y agent-memory-store"
```

### opencode

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agent-memory-store": {
      "type": "local",
      "command": ["npx", "-y", "agent-memory-store"],
      "enabled": true
    }
  }
}
```

### Cursor / VS Code (MCP extension)

Add to your MCP settings file:

```json
{
  "servers": {
    "agent-memory-store": {
      "command": "npx",
      "args": ["-y", "agent-memory-store"]
    }
  }
}
```

### Custom storage path

If you need to store memory outside the project directory, set `AGENT_STORE_PATH` in the environment block.

**Claude Code:**

```json
{
  "mcpServers": {
    "agent-memory-store": {
      "command": "npx",
      "args": ["-y", "agent-memory-store"],
      "env": {
        "AGENT_STORE_PATH": "/absolute/path/to/.agent-memory-store"
      }
    }
  }
}
```

**opencode:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agent-memory-store": {
      "type": "local",
      "command": ["npx", "-y", "agent-memory-store"],
      "enabled": true,
      "environment": {
        "AGENT_STORE_PATH": "/absolute/path/to/.agent-memory-store"
      }
    }
  }
}
```

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_STORE_PATH` | `./.agent-memory-store` | Custom path to the storage directory. Omit to use project default. |

---

## Teach your agent to use memory

Add this to your agent's system prompt (or `CLAUDE.md` / `AGENTS.md`):

```markdown
## Memory

You have persistent memory via agent-memory-store MCP tools.

**Before acting on any task:**

1. `search_context` with 2–3 queries related to the task. Check for prior decisions, conventions, and relevant outputs.
2. `get_state("project_tags")` to load the tag vocabulary. If empty, this is a new project — ask the user about stack, conventions, and structure, then persist them with `write_context` and `set_state`.

**After completing work:**

1. `write_context` to persist decisions (with rationale), outputs (with file paths), and discoveries (with impact).
2. Use short, lowercase tags consistent with the vocabulary: `auth`, `config`, `decision`, `output`, `discovery`.
3. Set `importance: "critical"` for decisions other agents depend on, `"high"` for outputs, `"medium"` for background context.

**Before every write:**

1. `search_context` for the same topic first. If a chunk exists, `delete_context` it, then write the updated version. One chunk per topic.

**Rules:**

- Never guess a fact that might be in memory — search first, it costs <10ms.
- Never store secrets — write references to where they live, not the values.
- `set_state` is for mutable values (current phase, counters). `write_context` is for searchable knowledge (decisions, outputs). Don't mix them.
- Use `search_mode: "semantic"` when exact terms don't match (e.g., searching "autenticação" when the chunk says "auth").
```

Copy, paste, done. This is enough for any agent to use memory effectively.

> **Advanced agent workflows:** The [`skills/SKILL.MD`](./skills/SKILL.MD) file is a comprehensive governance skill covering cold-start bootstrap, multi-agent pipeline handoffs, tag vocabulary management, deduplication workflows, performance budgets, and when to use each search mode. See the [full documentation](./docs/DOCUMENTATION.md) for a detailed walkthrough of all patterns.

---

## Tools

| Tool | When to use |
| --- | --- |
| `search_context` | **Start of every task** — retrieve relevant prior knowledge before acting |
| `write_context` | After decisions, discoveries, or outputs that other agents will need |
| `read_context` | Read a specific chunk by ID |
| `list_context` | Inventory the memory store (metadata only, no body) |
| `delete_context` | Remove outdated or incorrect chunks |
| `get_state` | Read a pipeline variable (progress, flags, counters) |
| `set_state` | Write a pipeline variable |

### `search_context`

```
query        string    Search query. Use specific, canonical terms.
tags         string[]  (optional) Narrow to chunks matching any of these tags.
agent        string    (optional) Narrow to chunks written by a specific agent.
top_k        number    (optional) Max results to return. Range: 1–20. Default: 6.
min_score    number    (optional) Minimum relevance score. Default: 0.1.
search_mode  string    (optional) "hybrid" (default), "bm25", or "semantic".
```

**Search modes:**

| Mode | How it works | Best for |
| --- | --- | --- |
| `hybrid` | BM25 + semantic similarity merged via Reciprocal Rank Fusion | General use (default) |
| `bm25` | FTS5 keyword matching only | Exact term lookups, canonical tags |
| `semantic` | Vector cosine similarity only | Finding conceptually related chunks |

**Response format:**

```
### [score: 0.85] Auth service — JWT decision
**id:** `a1b2c3d4e5` | **agent:** pm-agent | **tags:** auth, decision | **importance:** critical | **updated:** 2025-06-01T14:00:00.000Z

[chunk content in markdown]

---

### [score: 0.71] ...
```

### `write_context`

```
topic       string    Short, specific title. ("Auth — JWT decision", not "decision")
content     string    Chunk body in markdown. Include rationale, not just conclusions.
agent       string    (optional) Agent ID writing this chunk.
tags        string[]  (optional) Canonical tags for future retrieval.
importance  string    (optional) low | medium | high | critical. Default: medium.
ttl_days    number    (optional) Auto-expiry in days. Omit for permanent storage.
```

Embeddings are computed asynchronously after the chunk is saved. The chunk is immediately searchable via BM25; semantic search results may lag by ~200ms.

### `read_context`

```
id    string    Chunk ID (10-char hex string from write_context or list_context).
```

Returns the full chunk including header metadata and body content.

### `list_context`

```
agent   string    (optional) Filter by agent ID.
tags    string[]  (optional) Filter by tags.
limit   number    (optional) Max results. Range: 1–500. Default: 100.
offset  number    (optional) Results to skip for pagination. Default: 0.
```

Returns metadata only (no body). Use for store inventory and curation.

### `delete_context`

```
id    string    Chunk ID to permanently delete.
```

### `get_state` / `set_state`

```
key    string   State variable name.
value  any      (set_state only) Any JSON-serializable value.
```

`get_state` returns `null` (not an error) for keys that don't exist yet.

---

## Architecture

```
src/
  index.js        MCP server — tool registration and transport
  store.js        Public API — searchChunks, writeChunk, readChunk, etc.
  db.js           SQLite layer — node:sqlite with FTS5, WAL mode
  search.js       Hybrid search — FTS5 BM25 + vector similarity + RRF
  embeddings.js   Local embeddings — @huggingface/transformers (all-MiniLM-L6-v2)
  bm25.js         Pure JS BM25 — reference implementation (not on hot path)
  migrate.js      Filesystem → SQLite migration (automatic, one-time)
```

### Storage format

All data lives in a single SQLite database at `.agent-memory-store/store.db`:

- **chunks table** — id, topic, agent, tags (JSON), importance, content, embedding (BLOB), timestamps, expiry
- **chunks_fts** — FTS5 virtual table synced via triggers for full-text search
- **state table** — key/value pairs for pipeline variables

WAL mode is enabled for concurrent read performance. No manual flush needed.

### How hybrid search works

1. **BM25 (FTS5)** — SQLite's native full-text search ranks chunks by term frequency and inverse document frequency. Fast, deterministic, great for exact keyword matches.

2. **Semantic similarity** — Query and chunks are embedded into 384-dimensional vectors using `all-MiniLM-L6-v2` (runs locally via ONNX Runtime). Cosine similarity finds conceptually related chunks even when exact terms don't match.

3. **Reciprocal Rank Fusion** — Both ranked lists are merged using RRF with weights (BM25: 0.4, semantic: 0.6). Documents appearing in both lists get boosted. The fusion formula is: `score = 0.4 / (60 + rank_bm25) + 0.6 / (60 + rank_semantic)`.

The embedding model (~23MB) is downloaded automatically on first use and cached in `~/.cache/huggingface/`. If the model fails to load, the system falls back to BM25-only search transparently.

---

## Performance

Benchmarked on Apple Silicon (Node v25, darwin arm64, BM25 mode):

| Operation | 1K chunks | 10K chunks | 50K chunks | 100K chunks | 250K chunks |
| --- | --- | --- | --- | --- | --- |
| **write** | 0.17 ms | 0.19 ms | 0.23 ms | 0.21 ms | 0.25 ms |
| **read** | 0.01 ms | 0.05 ms | 0.21 ms | 0.22 ms | 0.85 ms |
| **search (BM25)** | ~5 ms† | ~10 ms† | ~60 ms† | ~110 ms† | ~390 ms† |
| **list** | 0.2 ms | 0.3 ms | 0.3 ms | 0.3 ms | 1.1 ms |
| **state get/set** | 0.03 ms | 0.03 ms | 0.07 ms | 0.05 ms | 0.03 ms |

† Search times from isolated run (no model loading interference). During warmup, first queries may be slower.

**Key insights:**

- **write is stable at ~0.2 ms/op** — FTS5 triggers and embedding backfill are non-blocking; inserts stay constant
- **read is a single index lookup** — sub-millisecond up to 50K chunks, still <1 ms at 250K
- **search scales linearly with FTS5 corpus** — for typical agent memory usage (≤25K chunks), search stays under 30 ms
- **list is O(1) in practice** — pagination caps results at 100 rows by default, so list time stays flat regardless of corpus size
- **state ops are O(1)** — key/value store backed by a B-tree primary key, constant at all scales

---

## LongMemEval Benchmark

`agent-memory-store` is benchmarked against the **LongMemEval** dataset (ICLR 2025), a standard for evaluating long-term memory in AI systems. The benchmark measures retrieval quality (Recall@5, Recall@10, NDCG@10) on 500 real conversation scenarios.

> **Context**: `agent-memory-store` is designed for _agent-curated memory_ — agents decide what to store, writing structured chunks with topic, tags, and importance. LongMemEval instead dumps raw conversation turns verbatim, which is outside this system's intended use case. Despite that mismatch, the retrieval engine achieves 92.1% Recall@5 — validating the underlying BM25 + semantic search infrastructure. In real agent usage, where chunks are pre-filtered and structured by the agent before writing, retrieval quality would be higher still.

### Results (500 questions)

| Mode | Recall@5 | Recall@10 | NDCG@10 | Questions |
| --- | --- | --- | --- | --- |
| **hybrid** | 92.1% | 96.9% | 0.885 | 479 |
| **bm25** | 92.0% | 95.9% | 0.901 | 479 |
| **semantic** | 86.1% | 92.5% | 0.821 | 479 |

### Performance by Question Type

Breakdown of hybrid mode across the 5 LongMemEval categories:

| Category | Count | Recall@5 | Recall@10 | NDCG@10 |
| --- | --- | --- | --- | --- |
| **single-session-assistant** | 56 | 96.4% | 98.2% | **0.970** |
| **knowledge-update** | 72 | 95.8% | 98.6% | 0.927 |
| **single-session-user** | 64 | 95.3% | 98.4% | 0.863 |
| **single-session-preference** | 30 | 93.3% | 96.7% | 0.784 |
| **multi-session** | 125 | 91.2% | 95.9% | 0.898 |
| **temporal-reasoning** | 132 | 87.4% | 95.7% | 0.847 |

### Competitive Positioning

Compared against published memory systems on LongMemEval Recall@5:

| System | Recall@5 | LLM Required |
| --- | --- | --- |
| **MemPalace hybrid+LLM** | 100.0% | Haiku |
| **MemPalace raw** | 96.6% | None |
| Mastra (GPT-4o-mini) | 94.87% | Yes |
| **agent-memory-store (hybrid)** | **92.1%** | **None** |
| Hindsight (Gemini) | 91.4% | Yes |
| Stella (dense baseline) | ~85% | None |
| Contriever (dense baseline) | ~78% | None |
| BM25 (sparse baseline) | ~70% | None |

**Key insight**: `agent-memory-store` achieves competitive retrieval quality **without any external LLM calls**, sitting between MemPalace raw and production systems like Mastra — all while using only local embeddings.

### Run the Benchmark

Test on a subset (quick validation):

```bash
node benchmarks/longmemeval_bench.js --limit 50
```

Full benchmark (500 questions, ~6 minutes with warm embedding cache):

```bash
npm run bench:longmemeval
# or
node benchmarks/longmemeval_bench.js
```

**Options:**

- `--limit N` — Run only first N questions (default: all 500)
- `--mode MODE` — Test specific mode: `hybrid`, `bm25`, `semantic`, or `all` (default: all)
- `--granularity GRAN` — Chunk strategy: `session` (default), `turn`, or `hybrid`
- `--top-k K` — Retrieval cutoff (default: 10)

Results are saved to `benchmarks/.cache/longmemeval_results.json` for analysis.

---

## Documentation

Full reference documentation is available at [`docs/DOCUMENTATION.md`](./docs/DOCUMENTATION.md):

- Complete tool reference with all parameters and return formats
- Search mode guide with examples and the RRF fusion formula
- SKILL.MD walkthrough — bootstrap protocol, handoff patterns, deduplication
- Multi-agent coordination patterns with code examples
- Architecture deep dive (each source file's role)
- Performance budgets and scaling guidance
- Anti-patterns and the quick-reference decision tree

---

## Development

```bash
git clone https://github.com/vbfs/agent-memory-store
cd agent-memory-store
npm install
npm start
```

Run tests:

```bash
npm test
```

Run benchmark:

```bash
node benchmark.js
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## License

MIT — see [LICENSE](./LICENSE).
