# agent-memory-store — Documentation

Full reference for all features, tools, search modes, the SKILL.MD governance skill, multi-agent coordination patterns, and architecture internals.

---

## Table of Contents

1. [Overview and Concepts](#1-overview-and-concepts)
   - 1.1 [What is a chunk?](#11-what-is-a-chunk)
   - 1.2 [What is state?](#12-what-is-state)
   - 1.3 [The two-store model](#13-the-two-store-model)
   - 1.4 [Project isolation](#14-project-isolation)
2. [Complete Tool Reference](#2-complete-tool-reference)
   - 2.1 [search_context](#21-search_context)
   - 2.2 [write_context](#22-write_context)
   - 2.3 [read_context](#23-read_context)
   - 2.4 [list_context](#24-list_context)
   - 2.5 [delete_context](#25-delete_context)
   - 2.6 [get_state](#26-get_state)
   - 2.7 [set_state](#27-set_state)
3. [Search Modes](#3-search-modes)
   - 3.1 [hybrid (default)](#31-hybrid-default)
   - 3.2 [bm25](#32-bm25)
   - 3.3 [semantic](#33-semantic)
   - 3.4 [Choosing a mode](#34-choosing-a-mode)
   - 3.5 [How RRF fusion works](#35-how-rrf-fusion-works)
4. [SKILL.MD Guide](#4-skillmd-guide)
   - 4.1 [What SKILL.MD is](#41-what-skillmd-is)
   - 4.2 [The read/write decision framework](#42-the-readwrite-decision-framework)
   - 4.3 [When to READ](#43-when-to-read)
   - 4.4 [When to WRITE](#44-when-to-write)
   - 4.5 [How to install the skill](#45-how-to-install-the-skill)
   - 4.6 [Compatibility](#46-compatibility)
5. [Multi-Agent Coordination](#5-multi-agent-coordination)
   - 5.1 [Pipeline handoff protocol](#51-pipeline-handoff-protocol)
   - 5.2 [Shared state conventions](#52-shared-state-conventions)
   - 5.3 [Conflict resolution](#53-conflict-resolution)
6. [Bootstrap Protocol](#6-bootstrap-protocol)
   - 6.1 [Detecting a virgin project](#61-detecting-a-virgin-project)
   - 6.2 [The four bootstrap writes](#62-the-four-bootstrap-writes)
   - 6.3 [Confirming with the user](#63-confirming-with-the-user)
7. [Deduplication](#7-deduplication)
   - 7.1 [Why duplicates form](#71-why-duplicates-form)
   - 7.2 [Search-before-write pattern](#72-search-before-write-pattern)
   - 7.3 [Judging relevance](#73-judging-relevance)
8. [Tag Discipline](#8-tag-discipline)
   - 8.1 [Tag rules](#81-tag-rules)
   - 8.2 [Bad/good comparison](#82-badgood-comparison)
   - 8.3 [Managing the vocabulary](#83-managing-the-vocabulary)
9. [Importance Levels](#9-importance-levels)
10. [TTL Guide](#10-ttl-guide)
11. [Performance Budgets](#11-performance-budgets)
    - 11.1 [Operation benchmarks](#111-operation-benchmarks)
    - 11.2 [Budget by corpus size](#112-budget-by-corpus-size)
    - 11.3 [Scaling beyond 25K chunks](#113-scaling-beyond-25k-chunks)
12. [Architecture Deep Dive](#12-architecture-deep-dive)
    - 12.1 [index.js — MCP server](#121-indexjs--mcp-server)
    - 12.2 [store.js — Public API](#122-storejs--public-api)
    - 12.3 [db.js — SQLite layer](#123-dbjs--sqlite-layer)
    - 12.4 [search.js — Hybrid search engine](#124-searchjs--hybrid-search-engine)
    - 12.5 [embeddings.js — Local embedding pipeline](#125-embeddingsjs--local-embedding-pipeline)
    - 12.6 [bm25.js — Pure JS BM25 (reference)](#126-bm25js--pure-js-bm25-reference)
    - 12.7 [migrate.js — Filesystem migration](#127-migratejs--filesystem-migration)
13. [Anti-Patterns](#13-anti-patterns)
14. [Quick Reference — Decision Tree](#14-quick-reference--decision-tree)

---

## 1. Overview and Concepts

### 1.1 What is a chunk?

A chunk is the atomic unit of memory. Each chunk is a structured record stored in the `chunks` table:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | 10-char hex (SHA-1 truncation of `agent:topic:timestamp:random`) |
| `topic` | string | Short, specific title — the primary search surface |
| `agent` | string | Agent ID that wrote this chunk (default: `"global"`) |
| `tags` | string[] | Canonical tags for filtering and retrieval |
| `importance` | string | `low` / `medium` / `high` / `critical` |
| `content` | string | Markdown body — the actual memory content |
| `embedding` | BLOB | 384-dim Float32 vector (may be `null` if not yet computed) |
| `created_at` | string | ISO 8601 timestamp |
| `updated_at` | string | ISO 8601 timestamp |
| `expires_at` | string | ISO 8601 timestamp, or `null` for permanent chunks |

Chunks accumulate over time. They are written once and retrieved by search. To update a chunk, delete the old one and write a new version.

### 1.2 What is state?

State is a flat key-value store backed by the `state` table. Values are JSON-serialized — any JSON-serializable value is valid (string, number, boolean, object, array).

State is designed for **mutable pipeline variables** that change frequently: current phase, active run ID, feature flags, counters. Unlike chunks, state is not searchable — it is retrieved only by exact key.

`get_state` returns `null` (not an error) for keys that don't exist yet.

### 1.3 The two-store model

Understanding when to use each is critical for correct agent behavior:

| | `write_context` / `search_context` | `set_state` / `get_state` |
| --- | --- | --- |
| **Model** | Accumulate over time | Point-in-time single value |
| **Retrieval** | Full-text + semantic search | Exact key lookup |
| **Use for** | Decisions, outputs, discoveries | Phase, run ID, flags, counters |
| **Overwrites?** | No — chunks accumulate (delete manually) | Yes — `set_state` overwrites |
| **Searchable?** | Yes | No |

Never use `set_state` for data that should be searchable. Never use `write_context` for mutable counters or flags.

### 1.4 Project isolation

By default, the store is created at `.agent-memory-store/store.db` relative to `process.cwd()` — the directory where the MCP server starts. Each project directory gets its own isolated store automatically.

To use a shared or global store, set `AGENT_STORE_PATH` to an absolute path:

```bash
AGENT_STORE_PATH=/home/user/.global-agent-memory npx agent-memory-store
```

This is useful for agents that need to share memory across multiple repositories or for global project context.

---

## 2. Complete Tool Reference

### 2.1 `search_context`

Search stored chunks using hybrid ranking (BM25 + semantic similarity). Call at the start of every task to retrieve relevant prior knowledge before acting.

**Parameters:**

| Name | Type | Required | Default | Constraints | Description |
| --- | --- | --- | --- | --- | --- |
| `query` | string | yes | — | — | Search query. Use specific, canonical terms. |
| `tags` | string[] | no | `[]` | — | Narrow to chunks matching any of these tags. |
| `agent` | string | no | — | — | Narrow to chunks written by a specific agent ID. |
| `top_k` | number | no | `6` | 1–20 | Maximum number of results to return. |
| `min_score` | number | no | `0.1` | ≥ 0 | Minimum relevance score. Lower = more permissive. |
| `search_mode` | string | no | `"hybrid"` | hybrid / bm25 / semantic | Search strategy. See [§3](#3-search-modes). |

**Example call:**

```json
{
  "query": "authentication decision JWT sessions",
  "tags": ["auth", "decision"],
  "top_k": 5,
  "search_mode": "hybrid"
}
```

**Response format:**

```
### [score: 0.85] Auth service — JWT decision
**id:** `a1b2c3d4e5` | **agent:** pm-agent | **tags:** auth, decision | **importance:** critical | **updated:** 2025-06-01T14:00:00.000Z

Chose stateless JWT. Rationale: no shared session store needed across services.
Refresh tokens stored in Redis with 7d TTL. Access tokens: 15min, RS256.

---

### [score: 0.71] Auth service — token refresh flow
...
```

Returns `"No matching chunks found."` when no results pass `min_score`.

---

### 2.2 `write_context`

Persist a memory chunk to the database. Call after completing a subtask, making a key decision, or producing output that downstream agents will need.

**Parameters:**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `topic` | string | yes | — | Short, specific title. `"Auth — JWT decision"` not `"decision"`. |
| `content` | string | yes | — | Chunk body in markdown. Include rationale, not just conclusions. |
| `agent` | string | no | `"global"` | Agent ID writing this chunk (e.g. `"pm-agent"`, `"scraper-agent"`). |
| `tags` | string[] | no | `[]` | Canonical tags for future retrieval. Use consistent terms. |
| `importance` | string | no | `"medium"` | `low` / `medium` / `high` / `critical`. See [§9](#9-importance-levels). |
| `ttl_days` | number | no | — | Auto-expiry in days. Omit for permanent storage. See [§10](#10-ttl-guide). |

**Example call:**

```json
{
  "topic": "Auth service — chose JWT over sessions",
  "content": "Chose stateless JWT. Rationale: no shared session store needed across services. Refresh tokens stored in Redis with 7d TTL. Access tokens: 15min, RS256.",
  "agent": "pm-agent",
  "tags": ["auth", "architecture", "decision"],
  "importance": "critical"
}
```

**Response:**

```
Chunk saved: id=`a1b2c3d4e5` | topic="Auth service — chose JWT over sessions" | tags=[auth, architecture, decision] | importance=critical
```

**Important:** Embeddings are computed asynchronously. The chunk is immediately searchable via BM25; semantic search results may lag by ~200ms while the embedding model processes the content.

---

### 2.3 `read_context`

Retrieve the full content of a specific chunk by its ID. Use when you know the exact chunk ID (from a previous `search_context` or `list_context` result).

**Parameters:**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | Chunk ID (10-char hex from `write_context` or `list_context`). |

**Response:**

```
## Auth service — chose JWT over sessions
**id:** `a1b2c3d4e5` | **agent:** pm-agent | **tags:** auth, decision | **importance:** critical | **updated:** 2025-06-01T14:00:00.000Z

Chose stateless JWT. Rationale: no shared session store needed across services...
```

Returns `"No chunk found with id \`{id}\`."` for unknown IDs.

---

### 2.4 `list_context`

List all stored chunks (metadata only, no body). Use for store inventory, curation, and finding chunks to delete.

**Parameters:**

| Name | Type | Required | Default | Constraints | Description |
| --- | --- | --- | --- | --- | --- |
| `agent` | string | no | — | — | Filter by agent ID. |
| `tags` | string[] | no | `[]` | — | Filter by tags (any match). |
| `limit` | number | no | `100` | 1–500 | Maximum results to return. |
| `offset` | number | no | `0` | ≥ 0 | Results to skip for pagination. |

**Example — paginate through a large store:**

```json
{ "limit": 100, "offset": 0 }   // page 1
{ "limit": 100, "offset": 100 } // page 2
{ "limit": 100, "offset": 200 } // page 3
```

**Response:**

```
3 chunk(s) found:

- `a1b2c3d4e5` **Auth service — JWT decision** | agent:pm-agent | tags:[auth, decision] | critical | 2025-06-01T14:00:00.000Z
- `f6g7h8i9j0` **Scraper run 042 — output** | agent:scraper-agent | tags:[scraper, output] | high | 2025-06-01T15:30:00.000Z
- `k1l2m3n4o5` **Staging deploy config** | agent:global | tags:[config, infra] | medium | 2025-05-28T09:00:00.000Z
```

---

### 2.5 `delete_context`

Permanently delete a chunk by ID. Use to remove outdated or incorrect memory before writing an updated version (see [§7 Deduplication](#7-deduplication)).

**Parameters:**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | Chunk ID to permanently delete. |

**Response:** `"Chunk \`{id}\` deleted."` or `"No chunk found with id \`{id}\`."`.

Deletion is permanent. Expired chunks (TTL-based) are also non-recoverable.

---

### 2.6 `get_state`

Read a pipeline state variable by key. Use to check progress, flags, and counters across agent turns.

**Parameters:**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | string | yes | State key to read (e.g. `"current_phase"`, `"project_tags"`). |

**Response:** The stored value as a string or formatted JSON. Returns `"State key "{key}" not found."` for missing keys — this is not an error condition.

**Common state keys by convention:**

| Key | Typical value | Description |
| --- | --- | --- |
| `project_tags` | `{ "vocabulary": [...], "updated": "..." }` | Tag vocabulary. Empty = virgin project. |
| `current_phase` | `"scraping"` / `"analysis"` | Pipeline phase tracker. |
| `pipeline_{run_id}` | `{ "phase": "...", "agent": "...", ... }` | Per-run state for multi-agent pipelines. |

---

### 2.7 `set_state`

Write a pipeline state variable. Overwrites any existing value for the same key.

**Parameters:**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | string | yes | State key (e.g. `"pipeline_status"`, `"current_phase"`). |
| `value` | any | yes | Any JSON-serializable value (string, number, boolean, object, array). |

**Response:** `"State "{key}" written at {timestamp}."`.

**Example:**

```json
{
  "key": "pipeline_run_042",
  "value": {
    "phase": "notification",
    "step": 3,
    "input_file": "data/shortlist.json",
    "agent": "notifier-agent",
    "started_at": "2025-06-01T14:00:00Z"
  }
}
```

---

## 3. Search Modes

### 3.1 hybrid (default)

Combines BM25 full-text search and semantic vector similarity, merged via Reciprocal Rank Fusion (RRF). This is the recommended mode for general use.

The query is processed in two parallel paths:
1. FTS5 BM25 search (synchronous, uses the `chunks_fts` virtual table)
2. Query embedding computation (asynchronous, 384-dim vector)

Results are then merged using RRF with weights BM25=0.4, semantic=0.6. See [§3.5](#35-how-rrf-fusion-works) for the formula.

Falls back to BM25-only silently if the embedding model is unavailable.

### 3.2 bm25

FTS5 keyword matching only. No embedding computation. Fast and deterministic.

FTS5 query construction: special characters (`* ^ : ( ) { } [ ]`) are stripped, tokens are split on whitespace, joined with `OR`, minimum token length is 2 characters. This means `"JWT auth decision"` becomes `JWT OR auth OR decision`.

**Best for:** exact tag lookups, canonical term searches, queries where you know the precise vocabulary used at write time.

### 3.3 semantic

Vector cosine similarity only. Brute-force: all stored embeddings are loaded into memory, cosine similarity is computed against the query embedding.

Content is truncated to 800 characters before embedding (topic + tags + content concatenated). The model (`all-MiniLM-L6-v2`) produces 384-dim Float32 vectors, mean-pooled and L2-normalized.

**Best for:** cross-lingual queries (e.g., searching "autenticação" when chunks say "auth"), conceptual similarity when exact terms differ.

**Memory note:** at 50K chunks, all embeddings occupy ~75MB of RAM (50,000 × 384 × 4 bytes). For large stores, prefer `bm25` or `hybrid` (which still benefits from semantic scoring without the full in-memory load).

### 3.4 Choosing a mode

| Situation | Recommended mode |
| --- | --- |
| General use (unknown query type) | `hybrid` |
| Exact tag or term lookup | `bm25` |
| Query in different language than stored content | `semantic` |
| Chunk just written (<200ms ago), need immediate result | `bm25` |
| Very large stores where memory is constrained | `bm25` |
| Embeddings not yet computed (embedding model failed) | `bm25` |

### 3.5 How RRF fusion works

Reciprocal Rank Fusion assigns a score to each document based on its rank in each list, then sums weighted contributions:

```
score = w_bm25  / (K + rank_bm25  + 1)
      + w_vec   / (K + rank_vec   + 1)
```

Where:
- `w_bm25 = 0.4`, `w_vec = 0.6`
- `K = 60` (smoothing constant — reduces sensitivity to top-rank differences)
- `rank_*` is 0-indexed position in each ranked list

Documents appearing in **both** lists receive additive contributions from both terms, naturally boosting high-quality matches. Documents appearing in only one list receive a partial score. RRF is robust to score scale differences between BM25 and cosine similarity.

---

## 4. SKILL.MD Guide

### 4.1 What SKILL.MD is

[`skills/SKILL.MD`](../skills/SKILL.MD) is a governance skill — a structured prompt file that agents load to govern when and how to interact with persistent memory.

It is **tool-agnostic**: the patterns apply to any MCP server exposing `search_context`/`write_context`/`get_state`/`set_state` equivalents. The skill uses Claude Code's frontmatter format to declare a name and a natural-language trigger description, so agents that support skill loading know when to activate it automatically.

**Two levels of memory instruction:**

| Level | What it is | When to use |
| --- | --- | --- |
| System prompt snippet (README) | 10-line quick-start guidance | Simple, single-agent use |
| `skills/SKILL.MD` | Full governance skill (12 sections) | Multi-agent pipelines, complex projects |

### 4.2 The read/write decision framework

Before taking any substantive action, ask two questions:

1. **"Is there something in memory I should know before I act?"**
   → If yes, or if uncertain: **read first**.

2. **"Will the result of this action be needed later — by me or another agent?"**
   → If yes: **write after**.

If both are yes, the pattern is: **read → act → write**.

If neither is yes, skip memory entirely and act normally. Memory is not a logging system — it stores decisions, outputs, and discoveries that affect future work.

### 4.3 When to READ

**Trigger 1 — Cold start (first action in a new session)**

Before any work in a fresh session, bootstrap your context:

```
search_context({ query: "project conventions stack architecture", top_k: 5 })
get_state("project_tags")
get_state("current_phase")
```

If all three return empty, you are in a virgin project. See [§6 Bootstrap Protocol](#6-bootstrap-protocol).

**Trigger 2 — New task or instruction received**

Search before doing anything else. You may have done related work before, or another agent may have left relevant context.

```
Incoming: "Set up the staging deployment pipeline"
→ search_context({ query: "staging deployment pipeline", top_k: 5 })
→ search_context({ query: "infrastructure decisions", top_k: 3 })
→ Incorporate findings, then proceed.
```

**Trigger 3 — A named entity appears**

When input mentions a specific project, system, service, agent, or acronym you don't have full context on, search before assuming.

```
Incoming: "Continue the TAYA Jira integration"
→ search_context({ query: "TAYA Jira integration", tags: ["taya", "jira"] })
```

Named entities are the strongest signal that prior work exists in memory.

**Trigger 4 — Uncertainty about a fact**

If you catch yourself about to write a value, URL, credential format, or decision you're not certain about — stop and search. Guessing when the answer exists in memory is the failure mode that makes multi-agent systems unreliable.

```
Internal signal: "I think the API endpoint was /v2/... but I'm not sure"
→ search_context({ query: "API endpoint config" })
```

**Trigger 5 — Handoff received from another agent**

Always read state and search for the sending agent's outputs before continuing.

```
Handoff: "HANDOFF Scraper→Analyzer | run-042 | ✅ | 87 items"
→ get_state("pipeline_run_042")
→ search_context({ query: "scraper output run 042", top_k: 4 })
```

The handoff message is a pointer, not a full briefing.

**Trigger 6 — Resuming after a pause or session restart**

If any signal suggests this task was interrupted, read state and search:

```
→ get_state("current_phase")
→ search_context({ query: "phase 3 output decisions", top_k: 5 })
```

### 4.4 When to WRITE

**Trigger 1 — Decision made with rationale**

Persist any non-trivial choice with the reasoning. Future agents need the *why*, not just the *what*.

```json
{
  "topic": "Auth service — chose JWT over sessions",
  "content": "Chose stateless JWT. Rationale: no shared session store needed across services. Refresh tokens stored in Redis with 7d TTL. Access tokens: 15min, RS256.",
  "tags": ["auth", "architecture", "decision"],
  "importance": "critical"
}
```

**Trigger 2 — Subtask completed with output**

When you finish a discrete unit of work that produces something another agent or future session will consume:

```json
{
  "topic": "Scraper run 042 — 87 listings collected",
  "content": "Raw file at data/raw.json. Source: ZAP Imóveis. Filters: SP capital, 2+ bedrooms, < R$800k. Rate: 2 req/s, 0 blocks. Duration: 4m12s.",
  "tags": ["scraper", "output"],
  "importance": "high"
}
```

**Trigger 3 — Discovery that changes understanding**

If you learn something that updates prior assumptions — an API changed, a config is different from documented, an edge case was found — write it immediately.

```json
{
  "topic": "ZAP API — rate limit changed to 1 req/s",
  "content": "As of 2025-06: rate limit tightened from 2 to 1 req/s. Previous setting causes 429s. Updated scraper config accordingly.",
  "tags": ["scraper", "config", "discovery"],
  "importance": "high",
  "ttl_days": 30
}
```

**Trigger 4 — Before ending your turn in a pipeline**

Before passing control, **always in this order**: write output → update state → send handoff.

If the handoff is sent before the write, the receiving agent may search memory before the chunk exists.

```
# 1. Persist output
write_context({
  topic: "Analyzer run 042 — shortlist produced",
  content: "214 analyzed → 12 shortlisted at data/shortlist.json. ...",
  tags: ["analyzer", "output"],
  importance: "high"
})

# 2. Update pipeline state
set_state("pipeline_run_042", {
  phase: "notification",
  step: 3,
  input_file: "data/shortlist.json",
  agent: "notifier-agent",
  started_at: "2025-06-01T14:00:00Z"
})

# 3. Send minimal handoff (detail is in memory)
# HANDOFF Analyzer→Notifier | run-042 | ✅ | 12 shortlisted
```

### 4.5 How to install the skill

**Claude Code (recommended):**

Copy `skills/SKILL.MD` to your Claude Code skills directory:

```bash
# Project-level (only for this project)
cp skills/SKILL.MD .claude/skills/SKILL.MD

# Global (available in all projects)
cp skills/SKILL.MD ~/.claude/skills/agent-memory.md
```

Claude Code reads the frontmatter `name:` and `description:` fields to decide when to activate the skill automatically. The description covers all the trigger conditions (new task, handoff, uncertainty, pipeline ending, etc.).

**Other clients (Cursor, opencode, custom agents):**

Paste the full content of `skills/SKILL.MD` into the system prompt or `CLAUDE.md`/`AGENTS.md`. Since the frontmatter metadata is used by Claude Code's skill loader, other clients treat it as plain markdown — the content is still fully effective as a system prompt.

### 4.6 Compatibility

The skill is tool-agnostic. The patterns apply to any MCP server exposing equivalent tool names. The frontmatter declares:

```yaml
name: agent-memory
description: "Governs when and how agents read from and write to a persistent memory store..."
```

If your MCP server uses different tool names (e.g., `memory_search` / `memory_save`), the skill still applies — the patterns are independent of tool naming.

---

## 5. Multi-Agent Coordination

### 5.1 Pipeline handoff protocol

The canonical handoff sequence between two agents:

**Agent A (finishing its turn):**

```
1. write_context({ topic: "...", tags: [..., "output"], importance: "high" })
2. set_state("pipeline_phase", { phase: "next", agent: "B", input: "...", started_at: "..." })
3. Send handoff message — lightweight, detail lives in memory
   e.g. "HANDOFF AgentA→AgentB | run-042 | ✅ | summary of output"
```

**Agent B (starting its turn):**

```
1. get_state("pipeline_phase")               ← get current context
2. search_context({ query: "agent A output", top_k: 5 })  ← retrieve output
3. Proceed with full context from memory
```

The handoff message should be **minimal** — just enough for Agent B to know which state key and search terms to use. All substantive context lives in the memory store.

### 5.2 Shared state conventions

**Use `set_state` for:**
- Current phase (`"scraping"`, `"analysis"`, `"notification"`)
- Active run ID
- Feature flags (`true` / `false`)
- Counters (items processed, retries remaining)

**Use `write_context` for:**
- Decisions (with rationale)
- Completed task outputs (with file paths)
- Discoveries (with impact on future work)
- Configuration captured at a point in time

**Never use `set_state` for searchable data.** State is a key-value store; context is a search engine. Use each for its strength.

**Example pipeline state object:**

```json
{
  "phase": "notification",
  "step": 3,
  "run_id": "042",
  "input_file": "data/shortlist.json",
  "agent": "notifier-agent",
  "started_at": "2025-06-01T14:00:00Z",
  "items_count": 12
}
```

### 5.3 Conflict resolution

When two agents write about the same topic concurrently (rare but possible in parallel pipelines), last write wins. To mitigate conflicts:

- Include timestamps in chunk content: `"As of 2025-06-01T14:00Z: ..."`
- Use agent-specific tags to distinguish authorship: `["scraper", "output"]` vs `["analyzer", "output"]`
- On read, when duplicates appear, prefer the chunk with the most recent `updated` timestamp
- Use the deduplication pattern ([§7](#7-deduplication)) proactively — it also detects concurrent writes

---

## 6. Bootstrap Protocol

### 6.1 Detecting a virgin project

At the start of any session, run:

```
get_state("project_tags")
```

If the result is `null` (key not found), the project has no memory yet. Before doing any task work, write the foundational chunks.

If the result exists, retrieve it and use the vocabulary for all writes in this session.

### 6.2 The four bootstrap writes

**Write 1 — Project identity:**

```json
{
  "topic": "Project bootstrap — identity and stack",
  "content": "Project: [name]. Stack: [languages, frameworks, databases]. Repo: [url]. Deploy: [target]. Architecture: [monolith/microservices/serverless].",
  "tags": ["project", "config"],
  "importance": "critical"
}
```

**Write 2 — Conventions:**

```json
{
  "topic": "Project conventions — code and workflow",
  "content": "Linter: [tool]. Formatter: [tool]. Test framework: [tool]. Branch strategy: [flow]. Commit format: [conventional/other]. PR policy: [review requirements].",
  "tags": ["project", "config", "decision"],
  "importance": "critical"
}
```

**Write 3 — Directory structure:**

```json
{
  "topic": "Project structure — key directories",
  "content": "src/ — application code. tests/ — test suites. docs/ — documentation. scripts/ — automation. config/ — environment configs.",
  "tags": ["project", "config"],
  "importance": "high"
}
```

**Write 4 — Tag vocabulary:**

```json
{
  "key": "project_tags",
  "value": {
    "vocabulary": ["project", "config", "decision", "output", "discovery", "auth", "api", "infra"],
    "updated": "2025-06-01"
  }
}
```

(Use `set_state` for the vocabulary, not `write_context`.)

### 6.3 Confirming with the user

The bootstrap should capture reality, not assumptions. Ask the user to confirm or adjust the four bootstrap writes before proceeding with the actual task. This is especially important for conventions (linter, test framework, branch strategy) and the tag vocabulary, which all future agents will inherit.

---

## 7. Deduplication

### 7.1 Why duplicates form

Duplicates form when agents write without checking first. The result is multiple chunks covering the same topic with different (often contradictory) content. When another agent searches for that topic, it gets conflicting results and cannot determine which is authoritative.

At 50 chunks, duplication is annoying. At 5,000 chunks, it makes the memory store unreliable.

### 7.2 Search-before-write pattern

Before every `write_context` call:

```
1. search_context({ query: "[topic you're about to write]", top_k: 3 })

2. If the top result is a clear match on the same topic:
   a. delete_context(results[0].id)
   b. write_context({ topic: "...", content: "updated version..." })

3. If no clear match:
   a. write_context({ ... }) directly
```

**Example:**

```
results = search_context({ query: "Jira config endpoint token", top_k: 3 })

# Top result: "Jira integration — endpoint and API token" — clear match
→ delete_context("f6g7h8i9j0")
→ write_context({ topic: "Jira config — endpoint and token", content: "Updated: endpoint changed to https://..." })
```

### 7.3 Judging relevance

Do not use score thresholds to judge whether a chunk is a duplicate. BM25 scores vary with corpus size: a score of 0.8 in a 500-chunk store may be as strong as 2.0 in a 50K-chunk store.

**Always judge by reading the top result's topic and content**, not its score. Ask: "Does this chunk cover the same topic I'm about to write?" If yes, it's a duplicate regardless of score. If no, write a new chunk.

A score-based threshold that works at 500 chunks will produce false negatives at 50K chunks (real duplicates missed) and false positives in small stores (unrelated chunks flagged).

---

## 8. Tag Discipline

### 8.1 Tag rules

- **Short and lowercase:** `auth`, `jira`, `scraper` — not `Authentication-Service`
- **No hyphens or spaces:** `ratelimit`, `apiquirk` — or use two separate tags: `api`, `quirk`
- **Use the canonical system name:** `taya`, `zap`, `postgres`, `redis`
- **Always include a type tag:** `decision`, `config`, `output`, `discovery`
- **Never invent a new tag when an existing one covers the concept**
- **At session start, always load** `get_state("project_tags")` and use that vocabulary

Tags are how agents find each other's work. A tag written as `auth` and searched as `authentication` produces no match. Consistency is non-negotiable.

### 8.2 Bad/good comparison

| Bad | Good | Why |
| --- | --- | --- |
| `authentication-service` | `auth` | Short, no hyphens |
| `JiraIntegration` | `jira` | Lowercase, canonical name |
| `myDecision` | `decision` | Generic type tag |
| `taya-api-endpoint-config` | `taya`, `config` | Split into system + type |
| `UpdatedSetting` | `discovery` or `config` | Use standard type vocabulary |
| `2025-scraper-output` | `scraper`, `output` | No dates in tags — use content |

### 8.3 Managing the vocabulary

Adding a new tag requires updating the shared vocabulary so all agents adopt it:

```
current = get_state("project_tags")
current.vocabulary.push("redis")
current.updated = "2025-06-01"
set_state("project_tags", current)
```

Add the new tag to the vocabulary **before** using it in a `write_context` call. If another agent runs a cold start while you're mid-session, it will inherit the updated vocabulary.

---

## 9. Importance Levels

| Level | Use when | Example |
| --- | --- | --- |
| `critical` | Another agent will fail or make wrong decisions without this | Architecture decision, API contract |
| `high` | Meaningfully changes how the next step runs | Task output with file paths, discovered rate limit |
| `medium` | Useful background, good to have — **this is the default** | General project context, tech stack notes |
| `low` | Ephemeral notes, debugging traces, things that may expire | Scratch notes, temporary workarounds |

When in doubt, use `high`. Underdeclaring importance means critical chunks may be skipped during curation passes; overdeclaring has no mechanical downside — it just means more chunks are prioritized.

---

## 10. TTL Guide

Most chunks should be **permanent** (omit `ttl_days`). Use TTL only for time-bound information:

| TTL | Use case |
| --- | --- |
| 1 day | Session-scoped scratch notes |
| 7–14 days | Rate limits, API quirks that change frequently |
| 30 days | A/B test results, time-bound experiment data |
| 90 days | Quarterly metrics snapshots |
| *(none)* | Everything else — permanent by default |

**Implementation detail:** expired chunks are purged automatically at server startup with:

```sql
DELETE FROM chunks WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
```

Expired chunks cannot be recovered. When uncertain, omit `ttl_days` — permanent chunks can always be deleted manually with `delete_context`.

---

## 11. Performance Budgets

### 11.1 Operation benchmarks

Measured on Apple Silicon (Node v25, darwin arm64, BM25 mode, isolated runs):

| Operation | 1K chunks | 10K chunks | 50K chunks | 100K chunks | 250K chunks |
| --- | --- | --- | --- | --- | --- |
| **write** | 0.17 ms | 0.19 ms | 0.23 ms | 0.21 ms | 0.25 ms |
| **read** | 0.01 ms | 0.05 ms | 0.21 ms | 0.22 ms | 0.85 ms |
| **search (BM25)** | ~5 ms | ~10 ms | ~60 ms | ~110 ms | ~390 ms |
| **list** | 0.2 ms | 0.3 ms | 0.3 ms | 0.3 ms | 1.1 ms |
| **state get/set** | 0.03 ms | 0.03 ms | 0.07 ms | 0.05 ms | 0.03 ms |

### 11.2 Budget by corpus size

| Corpus size | Search latency | Reads | Writes | Recommendation |
| --- | --- | --- | --- | --- |
| < 5K chunks | < 15ms/query | 0.02ms | 0.17ms | No constraints |
| 5–25K | 15–35ms/query | 0.02ms | 0.18ms | Normal operation |
| 25–50K | 35–60ms/query | 0.02ms | 0.18ms | Consider partitioning by domain |
| 50–100K | 60–110ms/query | 0.10ms | 0.18ms | Partition recommended |
| > 100K | 110ms+/query | 1.0ms+ | 0.20ms | Split into separate stores |

**Practical guidance:**

- A typical project stays under 5K chunks. At this size, 3 searches per action add under 50ms total — invisible next to LLM latency of 1–3 seconds.
- `list_context` without filters is O(n). Always use tag/agent filters or pagination when listing at scale.
- Do 2–3 targeted searches per read trigger, not one broad search. Specific queries outperform vague ones on BM25.
- `write` stays constant at ~0.2ms regardless of corpus size — FTS5 triggers and embedding backfill are non-blocking.

### 11.3 Scaling beyond 25K chunks

At 25K+ chunks:

**Semantic search memory:** At 50K chunks with 384-dim Float32 embeddings, brute-force cosine loads ~75MB of embedding data. Consider switching to `bm25` mode or partitioning.

**Partitioning strategy:** Create separate stores per domain using `AGENT_STORE_PATH`:
- `/project/.agent-memory-store/` — project-level memory
- `/project/.agent-memory-auth/` — auth domain only
- `/project/.agent-memory-infra/` — infrastructure only

Each store runs its own MCP server instance. Agents choose which server to query based on the task domain.

**`list_context` at scale:** Pagination caps results at 500 rows maximum. Always filter by `agent` or `tags` when listing large stores to avoid full-table scans.

---

## 12. Architecture Deep Dive

### 12.1 `index.js` — MCP server

Entry point. Registers all 7 tools via `@modelcontextprotocol/sdk`. Uses `zod/v4` for parameter validation with explicit `.describe()` strings that appear in the MCP tool manifest (these are what agents see when they inspect available tools).

Calls `initStore()` at startup — this runs DB initialization, triggers filesystem migration if needed, and warms up the embedding model in the background. The server accepts connections via `StdioServerTransport`.

### 12.2 `store.js` — Public API

The single export layer between `index.js` and the DB/search/embedding modules. All 7 MCP operations go through here.

**Chunk ID generation:** `crypto.createHash('sha1').update(\`${agent}:${topic}:${Date.now()}:${Math.random()}\`).digest('hex').slice(0, 10)` — 10-char hex, collision-resistant for typical agent memory volumes.

**Async embedding on write:** `writeChunk()` calls `insertChunk()` synchronously (chunk is immediately queryable via BM25), then calls `embed(text).then(embedding => updateEmbedding(id, embedding))` asynchronously. A `backfillEmbeddings()` function on startup processes any chunks that still have `null` embeddings (e.g., from a previous run where the embedding model failed).

### 12.3 `db.js` — SQLite layer

Uses `node:sqlite` — the SQLite module built into Node.js >= 22.5. No external database dependency.

**Schema:**

```sql
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  agent TEXT NOT NULL,
  tags TEXT DEFAULT '[]',      -- JSON array
  importance TEXT DEFAULT 'medium',
  content TEXT NOT NULL,
  embedding BLOB,              -- Float32Array, null until backfilled
  created_at TEXT,
  updated_at TEXT,
  expires_at TEXT
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  id UNINDEXED, topic, content,
  content='chunks', content_rowid='rowid'
);
```

FTS5 stays in sync via three triggers (INSERT, DELETE, UPDATE on `chunks`). WAL mode is set at connection time via `PRAGMA journal_mode = WAL`. A prepared statement cache (`stmtCache`) avoids re-preparing identical SQL.

**Expiry cleanup** runs at startup: `DELETE FROM chunks WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`.

**STORE_PATH resolution:** `process.env.AGENT_STORE_PATH || path.join(process.cwd(), '.agent-memory-store')`.

### 12.4 `search.js` — Hybrid search engine

Three search modes, selected by the `mode` parameter:

**`hybrid`:** Runs FTS5 BM25 search synchronously. Concurrently embeds the query. When both complete, applies RRF fusion. Uses a `bm25Map` cache to avoid redundant `getChunk()` DB reads for chunks that appear in both lists.

**`bm25`:** Calls `searchFTS()` from `db.js` directly. Returns ranked results immediately.

**`semantic`:** Embeds the query, loads all stored embeddings from DB (filtered by agent/tags if provided), computes cosine similarity for each, sorts by score.

**Graceful fallback:** If `embed()` returns `null` (model unavailable), hybrid and semantic modes fall back to BM25 results transparently.

### 12.5 `embeddings.js` — Local embedding pipeline

Uses `@huggingface/transformers` with ONNX Runtime for inference. Model: `all-MiniLM-L6-v2`.

**Lazy initialization:** The pipeline loads on the first `embed()` call, not at server start. A `loadingPromise` deduplicates concurrent load attempts — only one download/initialization happens even if multiple chunks are written simultaneously.

**Input construction:** `[topic, tags.join(' '), content.slice(0, 800)]` joined with space. Content is truncated at 800 characters before embedding.

**Post-processing:** Mean pooling across token embeddings, then L2 normalization to unit vector.

**Graceful degradation:** If the model fails to load (network unavailable, disk error, Node.js version mismatch), `loadFailed = true` and all subsequent `embed()` calls return `null` without throwing. `search.js` detects `null` and falls back to BM25.

### 12.6 `bm25.js` — Pure JS BM25 (reference)

A pure JavaScript BM25 implementation with standard parameters (k1=1.5, b=0.75), Unicode-normalized tokenization (handles accents), and IDF weighting.

**This module is not on the hot path.** It has no runtime callers in the current codebase. All live BM25 search goes through SQLite FTS5 in `db.js`. This file is kept as a reference implementation and fallback option if the SQLite FTS5 approach needs to be replaced.

### 12.7 `migrate.js` — Filesystem migration

Handles one-time migration from the legacy filesystem format (chunks as `.md` files with gray-matter YAML frontmatter, state as `.json` files) to the current SQLite format.

**Trigger condition:** `chunks/` directory exists but `store.db` does not.

**Process:**
1. Read all `.md` files from `chunks/`
2. Parse YAML frontmatter with `gray-matter`
3. Skip expired chunks (don't migrate stale data)
4. Insert valid chunks into the new `chunks` table
5. Rename `chunks/` → `chunks_backup/` and `state/` → `state_backup/`

Migration is silent and automatic — no user action needed. Post-migration, the backup directories can be deleted once the new store is verified.

---

## 13. Anti-Patterns

**Don't search reflexively.** Only search when you genuinely need external information. A mathematical question doesn't need a memory search. Save searches for facts that might exist in memory.

**Don't write conversational exchanges.** Memory stores decisions, outputs, and discoveries — not chat history or intermediate reasoning. If it won't help a future agent, don't write it.

**Don't use vague topics.** `"Update"`, `"Info"`, `"Note"` are unsearchable. A topic must be specific enough that a different agent can find it with a relevant query six months later: `"ZAP API — rate limit changed to 1 req/s"` not `"API update"`.

**Don't write without rationale.** A chunk that says `"Using Redis"` is much less useful than one explaining *why* Redis was chosen over alternatives. Future agents need context to decide whether a decision still applies.

**Don't skip deduplication.** Writing without searching first is how memory fills with contradictory chunks. Always search before write. See [§7](#7-deduplication).

**Don't threshold BM25 scores for dedup decisions.** Scores vary with corpus size. Read the top result's content to judge relevance, not its score.

**Don't ignore low-score results.** A result with a low score might still be the only chunk on a topic. Read the top result even when scores are low — just weight it accordingly in your reasoning.

**Don't store secrets in memory.** API keys, tokens, passwords, and connection strings with credentials belong in `.env` files or secret managers — not in a searchable text store. Write *references* to where secrets live: `"API key stored in .env as OPENAI_API_KEY"`.

**Don't use `set_state` for searchable data.** State is not indexed by content — it can only be retrieved by exact key. If something needs to be found by search, use `write_context`.

**Don't use `write_context` for mutable counters or flags.** Chunks accumulate — they don't overwrite. Using `write_context` for a counter creates a new chunk on every update. Use `set_state` instead.

**Don't send the handoff message before `write_context`.** The receiving agent may search memory immediately on receiving the handoff. If the write hasn't happened yet, the agent proceeds without the context it needs. Always: write → state → handoff.

---

## 14. Quick Reference — Decision Tree

```
┌─ New session?
│   └─ get_state("project_tags")
│       ├─ null → Bootstrap (§6), then proceed
│       └─ exists → search conventions + current phase, then proceed
│
├─ New task arrives?
│   └─ search_context (2–3 queries) → incorporate → act
│
├─ Named entity in input?
│   └─ search_context (entity name + tags)
│
├─ Feeling uncertain?
│   └─ search_context (topic of uncertainty)
│
├─ Handoff received?
│   └─ get_state (run/pipeline ID) + search_context (sending agent output)
│
├─ Resuming after pause?
│   └─ get_state (current_phase) + search_context (last phase output)
│
├─ Decision made?
│   └─ search (dedup) → write_context (topic + rationale + tags + importance)
│
├─ Subtask complete?
│   └─ search (dedup) → write_context (output + file paths + key facts)
│
├─ Discovery made?
│   └─ search (dedup) → write_context (what changed + impact, ttl if temporary)
│
├─ Turn ending in pipeline?
│   └─ write_context → set_state → send handoff (always this order)
│
└─ None of the above?
    └─ Act normally. Memory is not needed for every action.
```
