---
name: agent-memory
description: "Governs when and how agents read from and write to a persistent memory store (agent-memory-store or any MCP server exposing search_context/write_context/get_state/set_state equivalents). Use this skill whenever an agent has access to persistent memory tools and needs to decide whether to read or write. Trigger on: starting a new task, receiving a handoff, resuming after interruption, encountering a named entity without full context, making a non-trivial decision, completing a subtask with output, discovering something that changes assumptions, or ending a turn in a multi-agent pipeline. Also trigger when the agent is about to guess something that might already exist in memory, or when building multi-agent pipelines that share context across sessions."
---

# Context Memory Skill

This skill governs **when** and **how** an agent interacts with its persistent
memory store. It is tool-agnostic: the patterns apply whether the server
exposes `search_context`/`write_context`, `memory_search`/`memory_save`,
or any equivalent read/write pair.

**Core principle:** an agent's context window is ephemeral; the memory store
is permanent. Every important decision, discovery, and output lives in the
store — not just in the current conversation.

---

## 1. The read/write decision framework

Before taking any substantive action, ask two questions:

1. **"Is there something in memory I should know before I act?"**
   → If yes, or if uncertain: **read first**.
2. **"Will the result of this action be needed later — by me or another agent?"**
   → If yes: **write after**.

If both are yes, the pattern is: **read → act → write**.

If neither is yes, skip memory entirely and act normally. Memory is not a
logging system — it stores decisions, outputs, and discoveries that affect
future work.

---

## 2. When to READ

### 2.1 — Cold start (first action in a new session)

Before any work in a fresh session, bootstrap your context:

```
search_context({ query: "project conventions stack architecture", topK: 5 })
get_state("project_tags")
get_state("current_phase")
```

If all three return empty, you are in a **virgin project**. See §5 (Bootstrap
protocol) for what to write before proceeding.

If results exist, incorporate them before acting on any user instruction.

### 2.2 — New task or instruction received

Any time a new task arrives that you haven't handled in this session,
search memory before doing anything else. You may have done related work
before, or another agent may have left relevant context.

```
Incoming: "Set up the staging deployment pipeline"
→ search_context({ query: "staging deployment pipeline", topK: 5 })
→ search_context({ query: "infrastructure decisions", topK: 3 })
→ Incorporate findings, then proceed.
```

**Why:** acting without checking memory risks duplicating work, contradicting
prior decisions, or missing configuration that already exists.

### 2.3 — A named entity appears

When input mentions a specific project name, system, service, agent, person,
or acronym you don't have full context on, search for it before assuming.

```
Incoming: "Continue the TAYA Jira integration"
→ search_context({ query: "TAYA Jira integration", tags: ["taya", "jira"] })
```

Named entities are the strongest signal that prior work exists in memory.
Never assume you know the current state of a named system without checking.

### 2.4 — Uncertainty about a fact

If you catch yourself about to write a value, URL, credential format, decision,
or configuration detail that you're not 100% certain about — stop and search.
Uncertainty is a read trigger. Guessing when the answer exists in memory is
the failure mode that makes multi-agent systems unreliable.

```
Internal signal: "I think the API endpoint was /v2/... but I'm not sure"
→ search_context({ query: "API endpoint config" })
```

### 2.5 — Handoff received from another agent

Always read state and search for the sending agent's outputs before continuing.

```
Handoff: "HANDOFF Scraper→Analyzer | run-042 | ✅ | 87 items"
→ get_state("pipeline_run_042")
→ search_context({ query: "scraper output run 042", topK: 4 })
```

The handoff message is a pointer, not a full briefing.

### 2.6 — Resuming after a pause or session restart

If any signal suggests this task was interrupted (references to phases,
run IDs, "continue from where we left off"), read state and search.

```
→ get_state("pipeline_current_phase")
→ search_context({ query: "phase 3 output decisions", topK: 5 })
```

---

## 3. When to WRITE

### 3.1 — Decision made with rationale

Any time you make a non-trivial choice, persist it with the reasoning.
Future agents need the *why*, not just the *what*.

```
write_context({
  topic: "Auth service — chose JWT over sessions",
  content: "Chose stateless JWT. Rationale: no shared session store needed across services. Refresh tokens stored in Redis with 7d TTL. Access tokens: 15min, RS256.",
  tags: ["auth", "architecture", "decision"],
  importance: "critical"
})
```

### 3.2 — Subtask completed with output

When you finish a discrete unit of work that produces something another agent
or future session will consume, persist it.

```
write_context({
  topic: "Scraper run 042 — 87 listings collected",
  content: "Raw file at data/raw.json. Source: ZAP Imóveis. Filters: SP capital, 2+ bedrooms, < R$800k. Rate: 2 req/s, 0 blocks. Duration: 4m12s.",
  tags: ["scraper", "output"],
  importance: "high"
})
```

### 3.3 — Discovery that changes understanding

If you learn something that updates prior assumptions — an API changed,
a config is different from documented, an edge case was found — write it
immediately, even if no action follows yet.

```
write_context({
  topic: "ZAP API — rate limit changed to 1 req/s",
  content: "As of 2025-06: rate limit tightened from 2 to 1 req/s. Previous setting causes 429s. Updated scraper config accordingly.",
  tags: ["scraper", "config", "discovery"],
  importance: "high",
  ttl_days: 30
})
```

### 3.4 — Before ending your turn in a pipeline

Before passing control, write your output, update state, then send handoff.
**Always in this order.** If the handoff is sent before the write, the
receiving agent may search memory before the chunk exists.

```
# 1. Persist output
write_context({
  topic: "Analyzer run 042 — shortlist produced",
  content: "214 analyzed → 12 shortlisted at data/shortlist.json. Criteria: price/m² < median, transport > 7, no legal flags.",
  tags: ["analyzer", "output"],
  importance: "high"
})

# 2. Update pipeline state
set_state("pipeline_current_phase", {
  phase: "notification",
  step: 3,
  input_file: "data/shortlist.json",
  agent: "notifier-agent",
  started_at: "2025-06-01T14:00:00Z"
})

# 3. Send minimal handoff (detail is in memory)
# HANDOFF Analyzer→Notifier | run-042 | ✅ | 12 shortlisted
```

---

## 4. Deduplication — search before every write

Before writing a new chunk, search for an existing one on the same topic.
If a relevant chunk exists (top result with clear topic match), **delete it
and rewrite** rather than creating a duplicate.

```
results = search_context({ query: "Jira config endpoint token", topK: 3 })

if results[0] is a clear match on the same topic:
    delete_context(results[0].id)

write_context({ topic: "Jira config — endpoint and token", ... })
```

**Why:** duplicate chunks fragment knowledge and produce contradictory search
results. One chunk per topic, kept current.

**Judging relevance:** use the topic and content of the top result, not just
the score. BM25 scores vary with corpus size — a score of 0.8 in a 500-chunk
store may be as strong a match as 2.0 in a 50K-chunk store. Read the result
and decide whether it covers the same topic you're about to write.

---

## 5. Bootstrap protocol (first session on a new project)

When `get_state("project_tags")` returns empty, the project has no memory yet.
Before doing any task work, write these foundational chunks:

### 5.1 — Project identity

```
write_context({
  topic: "Project bootstrap — identity and stack",
  content: "Project: [name]. Stack: [languages, frameworks, databases]. Repo: [url]. Deploy: [target]. Architecture: [monolith/microservices/serverless].",
  tags: ["project", "config"],
  importance: "critical"
})
```

### 5.2 — Conventions

```
write_context({
  topic: "Project conventions — code and workflow",
  content: "Linter: [tool]. Formatter: [tool]. Test framework: [tool]. Branch strategy: [flow]. Commit format: [conventional/other]. PR policy: [review requirements].",
  tags: ["project", "config", "decision"],
  importance: "critical"
})
```

### 5.3 — Directory structure

```
write_context({
  topic: "Project structure — key directories",
  content: "src/ — application code. tests/ — test suites. docs/ — documentation. scripts/ — automation. config/ — environment configs.",
  tags: ["project", "config"],
  importance: "high"
})
```

### 5.4 — Tag vocabulary

```
set_state("project_tags", {
  vocabulary: ["project", "config", "decision", "output", "discovery", "auth", ...],
  updated: "2025-06-01"
})
```

Ask the user to confirm or adjust these before proceeding with the actual task.

---

## 6. Tag discipline

Tags are how agents find each other's work. A tag written as `auth` and
searched as `authentication` produces no match. Consistency is non-negotiable.

**Rules:**

- Short, lowercase, no hyphens: `auth`, `jira`, `scraper` — not `authentication-service`
- Use the canonical system name: `taya`, `zap`, `postgres`
- Include the chunk type: `decision`, `config`, `output`, `discovery`
- Never invent a new tag when an existing one covers the concept
- At session start, always run `get_state("project_tags")` and use that vocabulary

**When you need a new tag:** add it to the vocabulary in state before using it.
This ensures all agents in the pipeline see and adopt it.

```
current = get_state("project_tags")
current.vocabulary.push("redis")
set_state("project_tags", current)
```

---

## 7. Importance levels

| Level      | Use when                                                        |
|------------|-----------------------------------------------------------------|
| `critical` | Another agent will fail or make wrong decisions without this    |
| `high`     | Meaningfully changes how the next step runs                     |
| `medium`   | Useful background, good to have — **this is the default**       |
| `low`      | Ephemeral notes, debugging traces, things that may expire       |

When in doubt, use `high`. Underdeclaring means important chunks get ignored
during curation; overdeclaring is a much smaller problem.

---

## 8. TTL — when to expire chunks

Most chunks should be **permanent** (no `ttl_days`). Use TTL only for:

| TTL        | Use case                                           |
|------------|----------------------------------------------------|
| 1 day      | Session-scoped scratch notes                       |
| 7–14 days  | Rate limits, API quirks that change frequently     |
| 30 days    | A/B test results, time-bound experiment data       |
| 90 days    | Quarterly metrics snapshots                        |
| *(none)*   | Everything else — permanent by default             |

Permanent chunks can always be deleted manually. Expired chunks cannot be
recovered. When uncertain, omit TTL.

---

## 9. Performance budget

Based on benchmarks (Node.js, SQLite backend, Apple Silicon):

| Corpus size | Search latency | Reads    | Writes   | Recommendation                  |
|-------------|----------------|----------|----------|---------------------------------|
| < 5K chunks | < 15ms/query  | 0.02ms   | 0.17ms   | No constraints                  |
| 5–25K       | 15–35ms/query  | 0.02ms   | 0.18ms   | Normal operation                |
| 25–50K      | 35–60ms/query  | 0.02ms   | 0.18ms   | Consider partitioning by domain |
| 50–100K     | 60–110ms/query | 0.10ms   | 0.18ms   | Partition recommended           |
| > 100K      | 110ms+/query   | 1.0ms+   | 0.20ms   | Split into separate stores      |

**Practical guidance:**

- A typical project stays under 5K chunks. At this size, 3 searches per action
  add < 50ms total — invisible next to LLM latency (1–3 seconds).
- `list()` without filters is O(n) and becomes the bottleneck at > 25K chunks.
  Always use tag filters or pagination when listing.
- Do 2–3 targeted searches per read trigger, not one broad search. Specific
  queries outperform vague ones on BM25.

---

## 10. Multi-agent coordination patterns

### 10.1 — Pipeline handoff protocol

```
Agent A (finishing):
  1. write_context({ topic: "...", tags: [..., "output"] })
  2. set_state("pipeline_phase", { phase: "next", agent: "B", ... })
  3. Send handoff message (lightweight, detail lives in memory)

Agent B (starting):
  1. get_state("pipeline_phase")
  2. search_context({ query: "agent A output", topK: 5 })
  3. Proceed with full context
```

### 10.2 — Shared state conventions

Use `set_state` for mutable, single-value data that changes frequently:
current phase, active run ID, feature flags, counters.

Use `write_context` for immutable records: decisions, outputs, discoveries.
These accumulate over time and are retrieved by search.

**Never use `set_state` for data that should be searchable.** State is a
key-value store; context is a search engine. Use each for its strength.

### 10.3 — Conflict resolution

When two agents write about the same topic concurrently (rare but possible
in parallel pipelines), the last write wins. To mitigate:

- Include timestamps in chunk content
- Use agent-specific tags (`scraper`, `analyzer`) to distinguish authorship
- On read, prefer the most recent chunk when duplicates appear

---

## 11. Anti-patterns

**Don't search reflexively.** Searching is for information retrieval, not for
confirming your own responses. Only search when you genuinely need external
information to proceed correctly. A question like "what is 2+2" does not
warrant a memory search.

**Don't write conversational exchanges.** Memory is for decisions, outputs,
and discoveries — not for logging chat history or intermediate reasoning.

**Don't use vague topics.** `"Update"`, `"Info"`, `"Note"` are unsearchable.
A topic must be specific enough that a different agent can find it with a
relevant query six months later.

**Don't write without rationale.** A chunk that says "Using Redis" is much
less useful than one explaining *why* Redis was chosen over alternatives.
Future agents need context to decide whether a decision still applies.

**Don't ignore low-score results.** A result with a low score might still be
the only chunk on a topic. Read the top result even when scores are low —
just weight it accordingly.

**Don't skip deduplication.** Writing without searching first is how memory
fills with contradictory chunks. Always search before write (§4).

**Don't store secrets in memory.** API keys, tokens, passwords, and connection
strings with credentials belong in `.env` files or secret managers — not in
a searchable text store. Write *references* to where secrets live, not the
secrets themselves.

---

## 12. Quick reference — decision tree

```
┌─ New session?
│   └─ get_state("project_tags")
│       ├─ Empty → Bootstrap (§5), then proceed
│       └─ Exists → search conventions + current phase, then proceed
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
│   └─ get_state (run/pipeline ID) + search_context
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