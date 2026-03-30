---
name: agent-memory-store-skill
description: >
  Teaches agents exactly when and how to use MCP agent-memory-store context/memory tools
  (search_context, write_context, get_state, set_state, and equivalents).
  Use this skill whenever an agent has access to any persistent memory MCP
  server and needs to decide when to read from or write to that memory.
  Apply when building multi-agent pipelines, when an agent receives a handoff,
  when resuming a paused task, when referencing prior decisions, or when the
  agent risks hallucinating information it should look up. Also apply when
  the agent is about to produce an important output, decision, or discovery
  that downstream agents or future sessions will need.
---

# Context Memory Skill

This skill governs **when** and **how** an agent should interact with its
persistent memory store via MCP tools. It is tool-agnostic: the patterns
apply whether the server exposes `search_context`/`write_context`,
`memory_search`/`memory_save`, or any equivalent read/write pair.

The core principle: **an agent's context window is ephemeral; the memory
store is permanent.** Every important decision, discovery, and output lives
in the store — not just in the current conversation.

---

## Search modes — choosing the right one

The memory store supports three search modes via the `search_mode` parameter:

| Mode | When to use | How it works |
|---|---|---|
| `hybrid` (default) | General retrieval — best quality | BM25 keyword ranking + semantic similarity, merged via Reciprocal Rank Fusion |
| `bm25` | Exact term lookups, canonical tags, known keywords | SQLite FTS5 full-text search — fast, deterministic |
| `semantic` | Conceptual similarity, when exact terms are unknown | Vector cosine similarity using local embeddings (384-dim) |

**Guidelines:**

- Use `hybrid` (default) unless you have a specific reason not to. It combines the strengths of both approaches.
- Use `bm25` when you know the exact tags or terminology used in the stored chunks. It's faster and more precise for keyword matches.
- Use `semantic` when you need to find chunks that are conceptually related but may use different terminology (e.g., searching for "authentication" when chunks use "login flow").

---

## The two questions to ask before every action

Before taking any substantive action, ask:

1. **"Is there something in memory I should know before I act?"**
   -> If yes, or if uncertain: **READ first**.

2. **"Will the result of this action be needed later — by me or another agent?"**
   -> If yes: **WRITE after**.

If both answers are yes, the pattern is: **read -> act -> write**.

---

## Agent onboarding — first session checklist

Every agent must run this sequence at the very start of its first session
on a project, before taking any action:

```
# Step 1 — load canonical tag vocabulary
tags = get_state("project_tags")

# Step 2 — if no vocabulary exists yet, you are the first agent: define it
if not tags:
    set_state("project_tags", ["decision", "config", "output", "discovery", ...])

# Step 3 — load project overview chunk
search_context({ query: "project overview vision goals", topK: 3 })

# Step 4 — load context relevant to your role
search_context({ query: "[your role] decisions prior work", topK: 5 })
```

**Why:** An agent that skips onboarding may contradict prior decisions, use
inconsistent tags that break future searches, or duplicate work already done.
The project overview chunk and tag vocabulary are the shared contract between
all agents on the pipeline.

---

## Project overview chunk — who writes it, what it contains

The first agent to run on any project must write a permanent overview chunk
that all subsequent agents will read during onboarding.

```
write_context({
  topic: "[project-name] — overview, goals, and tag vocabulary",
  content: """
    Project: [name]
    Goal: [one sentence]
    Agents: [list of agents and their roles]
    Tag vocabulary: [canonical tags for this project]
    Key constraints: [important boundaries, e.g. rate limits, budget, deadlines]
    Entry point: [where to start / main files or endpoints]
  """,
  tags: ["meta", "onboarding", "[project-name]"],
  importance: "critical"
  // no TTL — permanent
})
```

This chunk is the "briefing document" for every agent that joins the pipeline.
Keep it updated when goals or vocabulary change.

---

## When to READ from memory

### Trigger 1 — New task or instruction received

Any time a new task arrives that you haven't handled in this session,
search memory before doing anything else. You may have done related work
before, or another agent may have left relevant context.

Use adaptive `top_k`: higher for broad orientation, lower for targeted lookups.

```
Incoming: "Build the property scoring module"
-> search_context({ query: "scoring module requirements criteria", topK: 8 })
-> search_context({ query: "data schema input fields", topK: 5 })
-> Incorporate findings before writing a single line of code
```

**Why:** Acting without checking memory risks duplicating work, contradicting
prior decisions, or missing configuration that already exists.

---

### Trigger 2 — A named entity appears

When input mentions a specific project name, system, service, agent, person,
or acronym you don't have full context on in the current session, search for it
before assuming.

```
Incoming: "The scraper is hitting rate limits again on ZAP"
-> search_context({ query: "ZAP rate limit scraper config", tags: ["scraper", "zap", "config"] })
```

Named entities are the clearest signal that prior work exists in memory.
Never assume you know the current state of a named system without checking.

---

### Trigger 3 — You feel uncertain or would have to guess

If you catch yourself about to write a value, URL, credential format, decision,
or configuration detail that you're not 100% certain about in this session —
stop and search. Uncertainty is a read trigger.

```
Internal signal: "I think the pagination param was 'offset' but I'm not sure"
-> search_context({ query: "API pagination parameters", agent: "scraper-agent", topK: 3 })
```

**Tip:** If you're uncertain about terminology, use `search_mode: "semantic"` to
find conceptually related chunks even when exact terms don't match.

**Why:** Guessing when the answer exists in memory is the failure mode that
makes multi-agent systems unreliable. Prefer one extra search over one wrong assumption.

---

### Trigger 4 — Handoff received from another agent

When you receive a handoff message, always read state and search for the
outputs and decisions from the sending agent before continuing.

```
Handoff: "HANDOFF Scraper->Analyzer | run-019 | OK | 143 listings | File: data/raw-019.json"
-> get_state("pipeline_run_019")
-> search_context({ query: "scraper run 019 output decisions", topK: 5 })
```

The handoff message is a pointer, not a full briefing. The full context lives
in memory.

---

### Trigger 5 — Resuming after a pause or session restart

If any signal suggests this task was interrupted (references to phases,
run IDs, "continue from where we left off", or prior session context),
read state and search before acting.

```
Incoming: "Resume the DOU pipeline, we stopped mid-processing"
-> get_state("dou_pipeline_current_phase")
-> search_context({ query: "DOU pipeline phase output last run", topK: 5 })
```

---

### Adaptive top_k guide

Do not use a fixed `topK` for all searches. Match it to the purpose:

| Search purpose | Recommended top_k |
|---|---|
| Broad orientation (new task, first session) | 8-10 |
| Targeted lookup (named entity, specific config) | 3-5 |
| Deduplication check before writing | 3 |
| Handoff context retrieval | 5-6 |

Higher `top_k` costs more tokens. Use it when orientation matters.
Use lower values when you know exactly what you're looking for.

---

## When to WRITE to memory

### Trigger A — Decision made with rationale

Any time you make a non-trivial choice — technology, approach, configuration,
architecture — write it with the reasoning. Future agents (and your future self)
need the *why*, not just the *what*.

```
write_context({
  topic: "Real estate pipeline — chose SQLite over flat JSON for listing store",
  content: "Chose SQLite for local listing persistence. Rationale: need deduplication by listing ID across runs; flat JSON requires full reload. Using node:sqlite. Schema: listings(id, portal, url, price, area, score, created_at).",
  tags: ["architecture", "decision", "database", "real-estate"],
  importance: "critical"
})
```

---

### Trigger B — Subtask completed with output

When you finish a discrete unit of work that produces something another agent
or future session will consume, persist it. This includes: files produced,
connection strings verified, credentials confirmed, API responses validated,
configurations applied, or any artifact that will be referenced downstream.

```
write_context({
  topic: "Scraper run 019 — 143 ZAP listings collected",
  content: "Raw file: data/raw-019.json. Portal: ZAP. Filters: SP capital, 2+ bedrooms, up to R$800k. Rate: 1 req/s (enforced after 429 in run 018). Zero blocks this run.",
  tags: ["scraper", "zap", "output", "real-estate"],
  importance: "high"
})
```

---

### Trigger C — Discovery that changes understanding

If you learn something that updates prior assumptions — an API changed,
a config is different from what was documented, an edge case was found —
write it immediately, even if no action follows yet.

```
write_context({
  topic: "OLX listings API — pagination changed to cursor-based",
  content: "As of 2025-06: OLX removed offset param, now uses cursor token in response header X-Next-Cursor. Previous scraper logic breaks at page 3+. Updated scraper-agent to follow cursor.",
  tags: ["scraper", "olx", "config", "discovery"],
  importance: "high",
  ttl_days: 60
})
```

---

### Trigger D — Before ending your turn in a pipeline

Before passing control to the next agent or completing your turn in a
multi-step pipeline, write your state. Think of it as "committing" your work.
The sequence is always: **write output chunk -> update state -> send handoff**.

```
# Step 1 — persist your output
write_context({
  topic: "Analyzer run 019 — shortlist of 11 properties",
  content: "143 listings analyzed. Shortlist: 11. File: data/shortlist-019.json. Criteria: price/sqm below neighborhood median, transport score > 7, no legal flags.",
  tags: ["analyzer", "real-estate", "output"],
  importance: "high"
})

# Step 2 — update pipeline state
set_state("pipeline_current_phase", {
  phase: "notification",
  step: 3,
  input_file: "data/shortlist-019.json",
  agent: "notifier-agent",
  started_at: "2025-06-01T14:00:00Z"
})

# Step 3 — send minimal handoff (the detail is in memory)
# HANDOFF Analyzer->Notifier | run-019 | OK | 11 shortlisted | File: data/shortlist-019.json
```

**Why this order:** if the handoff is sent before the write, the receiving agent
may search memory before the chunk exists and proceed with incomplete context.

---

## The deduplication rule — always search before writing

Before writing a new chunk, search for an existing one on the same topic.
If a chunk already exists, **update by deleting and rewriting** rather than
creating a duplicate.

```
# Before writing about "OLX scraper config":
results = search_context({ query: "OLX scraper config rate limit", topK: 3 })

if results:
    delete_context(results[0].id)   # remove stale version

write_context({ topic: "OLX scraper — config and rate limit", ... })
```

Duplicate chunks fragment knowledge and produce contradictory search results.
One chunk per topic, kept current.

---

## Zero results — what it means and what to do

When `search_context` returns empty, do not assume there is nothing to know.
There are two interpretations:

1. **You are the first agent to touch this topic** — you have a responsibility
   to write the foundational chunk after completing your work.

2. **Tags or query terms don't match what was written** — try alternate terms
   or switch to `search_mode: "semantic"` before concluding memory is empty.

```
# First attempt returns nothing:
search_context({ query: "DOU monitoring config regex", topK: 5 })  -> []

# Retry with semantic search for conceptual match:
search_context({ query: "official gazette scraper rules", topK: 5, search_mode: "semantic" })

# Retry with tag filter:
search_context({ query: "DOU pipeline setup", tags: ["dou"] })

# If still empty — you are the first. Write the foundational chunk after acting.
```

Never skip the write step just because you found nothing. Empty memory is an
invitation to build it.

---

## Tag discipline — the contract between agents

Tags are how agents find each other's work. A tag written as `auth` and
searched as `authentication` produces no match in BM25 mode (though semantic
search can bridge this gap). Tags must be agreed upon and used consistently
across all agents in a pipeline.

**Principles:**
- Use short, lowercase, hyphen-free terms: `auth`, `scraper`, `config`, not `authentication-service`
- Prefer the canonical project or system name: `dou`, `zap`, `olx`, `voc`
- Always include the chunk type: `decision`, `config`, `output`, `discovery`
- Never invent a new tag when an existing one covers it
- Load `get_state("project_tags")` during onboarding — don't guess the vocabulary

**Defining the vocabulary at project start:**
```
get_state("project_tags")
# -> if null, you are the first agent. Define and persist:
set_state("project_tags", [
  "decision", "config", "output", "discovery", "meta", "onboarding",
  "scraper", "analyzer", "notifier",       // agent roles
  "zap", "olx", "viva-real",               // portals
  "real-estate", "voc", "dou"              // projects
])
```

---

## Importance levels — when to use each

| Level | Use when |
|---|---|
| `critical` | Another agent will fail or make wrong decisions without this |
| `high` | Important context that meaningfully changes how the next step runs |
| `medium` | Useful background, good to have (default) |
| `low` | Ephemeral notes, debugging traces, things that may expire |

When in doubt, use `high`. Underdeclaring importance means important chunks
get ignored during curation; overdeclaring is a much smaller problem.

---

## TTL — when to expire chunks

Most chunks should be **permanent** (no `ttl_days`). Use TTL only for:

- Session-scoped scratch notes (`ttl_days: 1`)
- Rate limit observations that change frequently (`ttl_days: 7-14`)
- Portal scraping configs that may drift (`ttl_days: 30-60`)
- Run-specific outputs in high-frequency pipelines (`ttl_days: 30`)
- Anything explicitly temporary

When uncertain, omit TTL. Permanent chunks can always be deleted manually;
expired chunks cannot be recovered.

---

## Anti-patterns — what NOT to do

**Don't search on every single LLM output.** Searching is for *information
retrieval*, not for confirming your own responses. Only search when you
genuinely need external information to proceed correctly.

**Don't write conversational exchanges.** Memory is for decisions, outputs,
and discoveries — not for logging chat history or intermediate reasoning steps.

**Don't use vague topics.** `"Update"`, `"Info"`, `"Note"` are unsearchable.
Topics must be specific enough that a different agent can find them
with a relevant query six months later.

**Don't write without rationale.** A chunk that says "Using Redis" with no
explanation is much less useful than one that explains why Redis was chosen
over alternatives. Future agents need context to know whether a decision
still applies.

**Don't ignore low-score results.** A result with a low score might still be
the only chunk on a topic. Read the top result even when scores are low —
just weight it accordingly.

**Don't use a fixed topK for all searches.** A broad orientation search with
`topK: 3` and a deduplication check with `topK: 10` are both wrong. Match
`top_k` to the purpose — see the adaptive guide above.

**Don't default to `bm25` mode out of habit.** The `hybrid` default exists
for a reason — it catches both keyword matches and semantic similarities.
Only override when you have a specific reason.

---

## Quick reference — read/write decision

```
First session on project
  -> get_state("project_tags") -> search_context("project overview") -> search_context("[my role]")

New task arrives
  -> search_context (2-3 queries, topK 8) -> incorporate -> act

Named entity in input
  -> search_context (entity name + tags, topK 5)

Feeling uncertain
  -> search_context (topic of uncertainty, topK 3) -> retry with semantic mode if empty

Handoff received
  -> get_state (run/pipeline ID) + search_context (topK 5-6)

Zero results returned
  -> retry with semantic mode or alternate terms -> if still empty: act, then write foundational chunk

Decision made
  -> write_context (topic, content with rationale, tags, importance: high/critical)

Subtask complete
  -> write_context (output description + file path + key facts)

Discovery made
  -> write_context (what changed + impact, ttl_days if temporary)

Turn ending in pipeline
  -> write_context (output) -> set_state (next phase + agent) -> send handoff

Before writing
  -> search_context (topK 3) -> delete stale -> write fresh
```
