# agent-memory-store

> High-performance MCP memory server for multi-agent systems — SQLite-backed with hybrid search.

[![npm version](https://img.shields.io/npm/v/agent-memory-store.svg)](https://www.npmjs.com/package/agent-memory-store)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.5-green.svg)](https://nodejs.org)

`agent-memory-store` gives your AI agents a shared, searchable, persistent memory — powered by SQLite with native FTS5 full-text search and optional semantic embeddings. No external services required.

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

## Features

- **Zero-install usage** via `npx`
- **Hybrid search** — BM25 full-text (FTS5) + semantic vector similarity + Reciprocal Rank Fusion
- **SQLite-backed** — single `store.db` file, WAL mode, native performance
- **Local embeddings** — 384-dim vectors via `all-MiniLM-L6-v2`, no API keys needed
- **Tag and agent filtering** — find chunks by who wrote them or what they cover
- **TTL-based expiry** — chunks auto-delete after a configurable number of days
- **Session state** — key/value store for pipeline progress, flags, and counters
- **MCP-native** — works with Claude Code, opencode, Cursor, and any MCP-compatible client
- **Zero external database dependencies** — uses Node.js built-in SQLite (`node:sqlite`)

## Requirements

- Node.js >= 22.5 (required for native `node:sqlite` with FTS5 support)

## Quick start

No installation needed:

```bash
npx agent-memory-store
```

By default, memory is stored in `.agent-memory-store/store.db` inside the directory where the server starts — so each project gets its own isolated store automatically.

To use a custom path:

```bash
AGENT_STORE_PATH=/your/project/.agent-memory-store npx agent-memory-store
```

## Performance

Benchmarked on Apple Silicon (Node v25, darwin arm64):

| Operation | 100 chunks | 1K chunks | 5K chunks | 10K chunks |
|-----------|-----------|-----------|-----------|------------|
| **write** | 2.16 ms | 0.15 ms | 0.15 ms | 0.15 ms |
| **read** | 0.02 ms | 0.02 ms | 0.02 ms | 0.02 ms |
| **search (BM25)** | 0.4 ms | 1.2 ms | 5.3 ms | 9.9 ms |
| **list** | 0.2 ms | 1.4 ms | 9.9 ms | 14.7 ms |
| **state get/set** | 0.03 ms | 0.03 ms | 0.03 ms | 0.03 ms |

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
|---|---|---|
| `AGENT_STORE_PATH` | `./.agent-memory-store` | Custom path to the storage directory. Omit to use project default. |

## Tools

| Tool | When to use |
|---|---|
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
top_k        number    (optional) Max results to return. Default: 6.
min_score    number    (optional) Minimum relevance score. Default: 0.1.
search_mode  string    (optional) "hybrid" (default), "bm25", or "semantic".
```

**Search modes:**

| Mode | How it works | Best for |
|---|---|---|
| `hybrid` | BM25 + semantic similarity merged via Reciprocal Rank Fusion | General use (default) |
| `bm25` | FTS5 keyword matching only | Exact term lookups, canonical tags |
| `semantic` | Vector cosine similarity only | Finding conceptually related chunks |

### `write_context`

```
topic       string    Short, specific title. ("Auth — JWT decision", not "decision")
content     string    Chunk body in markdown. Include rationale, not just conclusions.
agent       string    (optional) Agent ID writing this chunk.
tags        string[]  (optional) Canonical tags for future retrieval.
importance  string    (optional) low | medium | high | critical. Default: medium.
ttl_days    number    (optional) Auto-expiry in days. Omit for permanent storage.
```

### `get_state` / `set_state`

```
key    string   State variable name.
value  any      (set_state only) Any JSON-serializable value.
```

## Architecture

```
src/
  index.js        MCP server — tool registration and transport
  store.js        Public API — searchChunks, writeChunk, readChunk, etc.
  db.js           SQLite layer — node:sqlite with FTS5, WAL mode
  search.js       Hybrid search — FTS5 BM25 + vector similarity + RRF
  embeddings.js   Local embeddings — @huggingface/transformers (all-MiniLM-L6-v2)
  bm25.js         Pure JS BM25 — kept as fallback reference
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

3. **Reciprocal Rank Fusion** — Both ranked lists are merged using RRF with weights (BM25: 0.4, semantic: 0.6). Documents appearing in both lists get boosted.

The embedding model (~23MB) is downloaded automatically on first use and cached in `~/.cache/huggingface/`. If the model fails to load, the system falls back to BM25-only search transparently.

### Migration from filesystem

If you're upgrading from a previous version that used `.md` files, the migration happens automatically on first startup. Your existing chunks and state are imported into SQLite, and the old directories are renamed to `chunks_backup/` and `state_backup/`.

## Agent system prompt

Paste this into the system prompt of every agent that should use the memory store:

```markdown
## Memory usage

You have access to a persistent local memory store via agent-memory-store MCP tools.

**At the start of each task:**

1. Call `search_context` with 2-3 specific queries related to what you are about to do.
2. Incorporate retrieved chunks into your reasoning.
3. Call `get_state` to check pipeline status if relevant.

**After completing a subtask:**

1. Call `write_context` to persist:
   - Decisions made and their rationale
   - Key discoveries or findings
   - Structured outputs intended for downstream agents
2. Use canonical tags consistent with the rest of the team.
3. Set `importance: high` or `critical` for information other agents will need.

**Best practices:**

- Specific topics: "ZAP scraper — stack decision" > "decision"
- Consistent tags: always use the same term (`auth`, not `authentication`)
- Check before writing: search first to avoid duplicate chunks
- Temporary context: use `ttl_days: 7` for session-scoped information
- Use `search_mode: "semantic"` when looking for conceptually related chunks
- Use `search_mode: "bm25"` for exact tag/keyword lookups
```

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

## Roadmap

- [ ] `summarize_context` tool — LLM-powered chunk consolidation
- [ ] `prune_context` tool — remove chunks by age, agent, or importance
- [x] ~~Hybrid scoring: BM25 + local embedding reranking~~ — shipped in v0.1.0
- [x] ~~SQLite-backed storage~~ — shipped in v0.1.0
- [ ] Web UI for browsing the memory store
- [ ] Multi-project workspace support

## License

MIT — see [LICENSE](./LICENSE).
