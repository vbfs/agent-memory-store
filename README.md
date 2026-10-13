# agent-memory-store

[![npm version](https://img.shields.io/npm/v/agent-memory-store.svg)](https://www.npmjs.com/package/agent-memory-store)
[![CI](https://github.com/vbfs/agent-memory-store/actions/workflows/ci.yml/badge.svg)](https://github.com/vbfs/agent-memory-store/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-green.svg)](https://nodejs.org)

**Shared, persistent memory for a team of AI agents, over MCP.** One SQLite file
per project, hybrid search (keyword + local multilingual embeddings), safe for
many agent processes at once. No API keys, no external services, no LLM calls.

```bash
claude mcp add agent-memory -s project -- npx -y agent-memory-store
```

---

## Why

Agents start every session from zero, and agents working in parallel don't
know what the others decided. `agent-memory-store` gives them one place to
**search before acting** and **write what others will need** — decisions with
their rationale, outputs and where they live, discoveries — plus a small
versioned key/value **state** for coordination (phase, owner, run id).

What makes it suitable for a team:

- **Multilingual retrieval** — a question in Portuguese finds a memory written in
  English and vice versa; exact identifiers (`PAG-4821`, `orders.v1`, paths)
  still match by keyword.
- **Many agents, one file** — WAL, busy timeouts and compare-and-set versions;
  tested with concurrent processes, no lost writes.
- **Update, don't duplicate** — write with an `id` to update in place; every
  write reports likely duplicates.
- **Safe by default** — natural-language queries can't break search,
  expired memories disappear immediately, credentials are refused on write.
- **Measured, not claimed** — every number below comes from scripts in
  `benchmarks/` that run the same code as the server.

## Quick start

Requires **Node.js ≥ 22.13**. The first start downloads the embedding model
(~310 MB) to `~/.cache/agent-memory-store/models`; until it is ready,
search runs in keyword mode.

### Claude Code

```bash
# shared by everyone who opens this repo (writes .mcp.json)
claude mcp add agent-memory -s project -- npx -y agent-memory-store
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["-y", "agent-memory-store"],
      "env": { "AGENT_MEMORY_AGENT": "backend-agent" }
    }
  }
}
```

### opencode (`opencode.json`)

```json
{
  "mcp": {
    "agent-memory": {
      "type": "local",
      "command": ["npx", "-y", "agent-memory-store"],
      "enabled": true
    }
  }
}
```

### Cursor / VS Code / other MCP clients

```json
{
  "mcpServers": {
    "agent-memory": { "command": "npx", "args": ["-y", "agent-memory-store"] }
  }
}
```

The store lives in `.agent-memory-store/store.db` under the directory the
client starts the server from — one store per project. Add
`.agent-memory-store/` to `.gitignore`. To share one store across repositories,
set `AGENT_STORE_PATH` to an absolute path.

### Teach your agents

The server sends a short usage protocol to the client automatically (MCP
server instructions). For multi-agent pipelines, add
[`skills/SKILL.md`](./skills/SKILL.md) as a skill or paste this into
`CLAUDE.md` / `AGENTS.md`:

```markdown
## Memory
- Before a task: `search_context` for prior decisions, conventions and outputs (any language).
- After a decision, output or discovery others need: `write_context` with a specific topic,
  the content with its rationale, and 1–4 lowercase tags.
- To change a memory, pass its `id` to `write_context`. Merge reported duplicates.
- Shared mutable values (phase, owner, run id): `get_state` / `set_state` with `expected_version`.
- Never store secrets — store where they live.
```

## Tools

| Tool | Purpose |
| --- | --- |
| `search_context` | Hybrid search. Filters: `tags`, `agent`, `since`/`until`. Returns snippets with score, similarity, version. |
| `write_context` | Create, or update in place with `id`. Optional `expected_version` (compare-and-set), `ttl_days`, `importance`. Reports likely duplicates. |
| `read_context` | Full text of one memory. |
| `list_context` | Newest first, metadata only, with total and paging. |
| `delete_context` | Delete one memory. |
| `get_state` / `set_state` | Versioned JSON values for coordination; `expected_version: 0` = claim if unset. |

Full parameters, response formats and behavior: [docs/DOCUMENTATION.md](./docs/DOCUMENTATION.md).

## How it works

```
 agent A ─┐                      ┌─ FTS5 BM25 (topic 3× · tags 2× · content)  ─┐
 agent B ─┼─ MCP stdio servers ──┤                                              ├─ score fusion ─ results
 agent C ─┘   (one per agent)    └─ local embeddings → in-memory vector index ─┘
                    │
                    └── .agent-memory-store/store.db  (SQLite, WAL, shared)
```

- **Keyword**: SQLite FTS5, accent-insensitive (`decisao` = `Decisão`); every
  query term is quoted, so punctuation and operators can't cause syntax errors.
- **Semantic**: `Snowflake/snowflake-arctic-embed-m-v2.0` (multilingual, ONNX 8-bit, CPU) and exact cosine search over
  an in-memory index that each process keeps in sync with the file.
- **Fusion**: weighted sum of per-query normalized scores, 70% semantic /
  30% keyword — chosen on held-out queries, see [Results](#results).
  Importance and recency only break near-ties.

## Results

One command, one process, ~30 s, < 1 GB RAM:

```bash
npm run bench
```

Measured on an Apple M2 (8 GB), Node 25.6. Raw outputs:
[`benchmarks/results/`](./benchmarks/results). Every benchmark runs the same
`MemoryStore` code as the MCP server; quality numbers are identical across
runs, and the metric code is unit-tested against hand-computed values.

### Quality — bilingual agent memory (golden set)

150 hand-written memories from a fictional product team (55% PT-BR, 45% EN),
120 queries: 35 cross-lingual, 35 paraphrases, 15 exact identifiers, 12
knowledge updates, 10 filtered, 13 multi-memory
([`benchmarks/golden/dataset.json`](./benchmarks/golden/dataset.json)).
Synthetic and small: a regression test for the intended use, not a leaderboard.

| Model (`AGENT_MEMORY_MODEL`) | Hit@1 | Recall@5 | MRR | Search p50 | Write p50 | RAM / process |
| --- | --- | --- | --- | --- | --- | --- |
| `none` (keyword only) | 50.8% | 70.0% | 0.587 | 0.7 ms | 0.1 ms | 64 MB |
| `minilm-l6-en` (0.0.x model) | 55.0% | 70.0% | 0.610 | 2.6 ms | 3.2 ms | 271 MB |
| `granite-97m-multilingual` | 66.7% | 88.3% | 0.770 | 4.5 ms | 5.8 ms | 453 MB |
| **`arctic-embed-m-v2` (default)** | **74.2%** | **95.8%** | **0.836** | **8.6 ms** | **13.9 ms** | **628 MB** |
| `embeddinggemma-300m` | 74.2% | 96.7% | 0.841 | 57.9 ms | 94.1 ms | 1372 MB |

Hybrid mode. Search and write latency with 2,000 memories in an on-disk store
(write includes embedding and the duplicate check; reads are < 0.1 ms).

### LongMemEval-S (ICLR 2025), keyword engine

Official retrieval protocol: session granularity, user turns only, abstention
and no-evidence questions excluded (**n = 419** of 500, cleaned release),
metrics from the official `eval_utils.py`.

| Mode | R_any@5 | R_all@5 | R_any@10 | R_all@10 | NDCG@10 |
| --- | --- | --- | --- | --- | --- |
| keyword (BM25) | 95.5% | 84.2% | 96.4% | 89.3% | 0.882 |

LongMemEval indexes raw chat logs, not curated memories, and embedding its
~16K long sessions takes about an hour and several GB of RAM on a laptop, so
the hybrid run is optional: `npm run bench:longmemeval` (`--sample 100` for a
stratified subset). The keyword run takes seconds:
`node benchmarks/longmemeval.js --model none`.

### How the defaults were chosen

- **Model** — `arctic-embed-m-v2` matches the best quality (EmbeddingGemma)
  within 0.005 MRR at 7× lower latency and half the RAM, is Apache-2.0, and
  separates near-duplicates well enough for the write-time duplicate warning.
  The 0.0.x model (`all-MiniLM-L6-v2`, English-only) fails cross-lingual
  queries: Recall@5 70.0% vs 95.8%.
- **Fusion** — equal-weight reciprocal rank fusion (0.0.x) scored *below*
  semantic-only search on the golden set, because keyword hits dilute
  cross-lingual and paraphrase queries. A grid over method × weight was run on
  the odd-numbered queries only; the chosen setting (convex combination, 0.7
  semantic) was then confirmed on the even half (`npm run bench:tune-fusion`).
  It keeps keyword strength for exact identifiers.
- **Duplicate warning** — the similarity threshold per model is set for a ~5%
  false-positive rate on the golden set's superseded/superseding pairs.

## Upgrading from 0.0.x

Existing stores migrate automatically on first start (content, tags,
timestamps and state are kept; vectors are recomputed in the background).
Tool names are unchanged; new optional parameters only. Fixed along the way:

- searches containing `? ' . - / ,` or `AND/OR/NOT` failed with FTS5 syntax errors;
- `min_score` was ignored; expired memories were returned until restart;
- updating meant delete + write; `INSERT OR REPLACE` left orphan index rows;
- concurrent processes could fail with `SQLITE_BUSY`;
- the previously published "92.1% Recall@5" came from a copy of the search
  code that differed from production, a non-standard recall metric and a
  competitor table mixing different metrics; it is replaced by the
  reproducible results above.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `AGENT_STORE_PATH` | `./.agent-memory-store` | Store directory. |
| `AGENT_MEMORY_AGENT` | `global` | Default agent id recorded on writes from this process. |
| `AGENT_MEMORY_MODEL` | `arctic-embed-m-v2` | Or `granite-97m-multilingual` (lighter), `embeddinggemma-300m`, `minilm-l6-en`, `none` (keyword only, ~64 MB RAM). All agents sharing a store must use the same model. |
| `AGENT_MEMORY_CACHE` | `~/.cache/agent-memory-store/models` | Model cache. |

## Limits

- Each agent process loads its own model copy (~630 MB with the default). With
  many agents on a small machine, use `granite-97m-multilingual` (~450 MB) or
  `none` (~64 MB, keyword only).
- Exact vector search is linear: fine up to ~100K memories per store.
- Only the first ~2000 characters of a memory are embedded; keyword search
  covers all of it. Prefer focused memories.
- Secret detection is pattern-based, not a DLP system. There is no access
  control: whoever can read `store.db` can read every memory.

## Development

```bash
npm install
npm test                    # unit, end-to-end over stdio, multi-process — no model download
AMS_MODEL_TESTS=1 npm test  # + end-to-end with the real model
npm run bench               # quality + speed, ~30 s
npm run bench:longmemeval   # optional, heavy (see above)
```

See [CONTRIBUTING.md](./CONTRIBUTING.md). Programmatic use (`import { MemoryStore } from "agent-memory-store"`) is documented in [docs/DOCUMENTATION.md](./docs/DOCUMENTATION.md#8-programmatic-use).

## License

MIT — see [LICENSE](./LICENSE).
