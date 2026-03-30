# agent-memory-store

> Local-first MCP memory server for multi-agent systems.

[![npm version](https://img.shields.io/npm/v/agent-memory-store.svg)](https://www.npmjs.com/package/agent-memory-store)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)

`agent-memory-store` gives your AI agents a shared, searchable, persistent memory — running entirely on your local filesystem. No vector database, no embedding APIs, no cloud services required.

Agents read and write **chunks** (markdown files with YAML frontmatter) through a set of MCP tools. Search is powered by **BM25**, the same ranking algorithm used by Elasticsearch, implemented in pure JavaScript with zero runtime dependencies.

```
                 ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
                 │   Agent A   │   │   Agent B   │   │   Agent C   │
                 └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
                        │                 │                  │
                        └────────────────┬─────────────────-┘
                                         │  MCP tools
                              ┌──────────▼──────────┐
                              │   agent-memory-store  │
                              │  search · write       │
                              │  read · state · list  │
                              └──────────┬──────────┘
                                         │
                              ┌──────────▼──────────┐
                              │  .agent-memory-store/ │
                              │  ├── chunks/          │
                              │  └── state/           │
                              └──────────────────────┘
```

## Features

- **Zero-install usage** via `npx`
- **BM25 full-text search** — relevance ranking without embeddings or APIs
- **Tag and agent filtering** — find chunks by who wrote them or what they cover
- **TTL-based expiry** — chunks auto-delete after a configurable number of days
- **Session state** — key/value store for pipeline progress, flags, and counters
- **Plain files** — chunks are `.md` files, readable and editable by humans and git
- **MCP-native** — works with Claude Code, opencode, and any MCP-compatible client

## Requirements

- Node.js ≥ 18

## Quick start

No installation needed:

```bash
npx agent-memory-store
```

By default, memory is stored in `.agent-memory-store/` inside the directory where the server starts — so each project gets its own isolated store automatically.

To use a custom path:

```bash
AGENT_STORE_PATH=/your/project/.agent-memory-store npx agent-memory-store
```

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
  "mcp": {
    "agent-memory-store": {
      "command": "npx",
      "args": ["-y", "agent-memory-store"]
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

If you need to store memory outside the project directory, set `AGENT_STORE_PATH` in the `env` block:

```json
{
  "mcp": {
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

### Environment variables

| Variable           | Default                 | Description                                                        |
| ------------------ | ----------------------- | ------------------------------------------------------------------ |
| `AGENT_STORE_PATH` | `./.agent-memory-store` | Custom path to the storage directory. Omit to use project default. |

## Tools

| Tool             | When to use                                                               |
| ---------------- | ------------------------------------------------------------------------- |
| `search_context` | **Start of every task** — retrieve relevant prior knowledge before acting |
| `write_context`  | After decisions, discoveries, or outputs that other agents will need      |
| `read_context`   | Read a specific chunk by ID                                               |
| `list_context`   | Inventory the memory store (metadata only, no body)                       |
| `delete_context` | Remove outdated or incorrect chunks                                       |
| `get_state`      | Read a pipeline variable (progress, flags, counters)                      |
| `set_state`      | Write a pipeline variable                                                 |

### `search_context`

```
query      string    Search query. Use specific, canonical terms.
tags       string[]  (optional) Narrow to chunks matching any of these tags.
agent      string    (optional) Narrow to chunks written by a specific agent.
top_k      number    (optional) Max results to return. Default: 6.
min_score  number    (optional) Minimum BM25 score. Default: 0.1.
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

### `get_state` / `set_state`

```
key    string   State variable name.
value  any      (set_state only) Any JSON-serializable value.
```

## Storage format

Each chunk is a plain `.md` file under `.agent-memory-store/chunks/`:

```markdown
---
id: a3f9c12b40
topic: "Auth service — chose JWT over sessions"
agent: architect-agent
tags: [auth, architecture, decision]
importance: high
updated: 2025-06-01T14:32:00.000Z
---

Chose stateless JWT over server-side sessions.

**Rationale:** No shared session store needed across services.
Refresh tokens stored in Redis with 7-day TTL.
Access tokens expire in 15 minutes.

**Trade-offs:** Cannot invalidate individual tokens before expiry.
Acceptable for our threat model.
```

Session state lives in `.agent-memory-store/state/<key>.json`.

Both directories are human-readable, diffable with git, and can be committed to version control if you want shared team memory.

## Agent system prompt

Paste this into the system prompt of every agent that should use the memory store:

```markdown
## Memory usage

You have access to a persistent local memory store via agent-memory-store MCP tools.

**At the start of each task:**

1. Call `search_context` with 2–3 specific queries related to what you are about to do.
2. Incorporate retrieved chunks (score > 1.0) into your reasoning.
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
- Consistent tags: always use the same term (`auth`, not `authentication` or `autenticação`)
- Check before writing: search first to avoid duplicate chunks
- Temporary context: use `ttl_days: 7` for session-scoped information
```

## How BM25 search works

BM25 ranks documents by term frequency and inverse document frequency, normalized by document length. It is the ranking algorithm behind Elasticsearch and Apache Lucene.

**Strengths:**

- Works well for short, labeled text chunks
- Instant — no network calls, no GPU, no warm-up
- Deterministic and explainable

**Limitations:**

- No semantic understanding (`car` ≠ `automobile`)
- Mitigated by using canonical tags and consistent terminology across agents

**Score interpretation:**

- `> 3.0` — strong match, highly relevant
- `1.0 – 3.0` — good match, likely relevant
- `0.1 – 1.0` — weak match, may be tangentially related
- `< 0.1` — filtered out by default

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

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## Project structure

```
src/
  bm25.js      BM25 ranking engine — pure JS, zero dependencies
  store.js     File-based persistence (chunks + session state)
  index.js     MCP server and tool definitions
```

## Roadmap

- [ ] `summarize_context` tool — LLM-powered chunk consolidation
- [ ] `prune_context` tool — remove chunks by age, agent, or importance
- [ ] Hybrid scoring: BM25 + optional local embedding reranking (ollama)
- [ ] Web UI for browsing the memory store
- [ ] Multi-project workspace support

## License

MIT — see [LICENSE](./LICENSE).
