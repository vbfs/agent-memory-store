---
name: agent-store-skill
description: >
  Teaches agents exactly when and how to use MCP agent-store context/memory tools
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

## The two questions to ask before every action

Before taking any substantive action, ask:

1. **"Is there something in memory I should know before I act?"**
   → If yes, or if uncertain: **READ first**.

2. **"Will the result of this action be needed later — by me or another agent?"**
   → If yes: **WRITE after**.

If both answers are yes, the pattern is: **read → act → write**.

---

## When to READ from memory

### Trigger 1 — New task or instruction received
Any time a new task arrives that you haven't handled in this session,
search memory before doing anything else. You may have done related work
before, or another agent may have left relevant context.

```
Incoming: "Set up the staging deployment pipeline"
→ search_context({ query: "staging deployment pipeline config", topK: 5 })
→ search_context({ query: "infrastructure decisions environment", topK: 3 })
→ Incorporate findings before proceeding
```

**Why:** Acting without checking memory risks duplicating work, contradicting
prior decisions, or missing configuration that already exists.

---

### Trigger 2 — A named entity appears
When input mentions a specific project name, system, service, agent, person,
or acronym you don't have full context on in the current session, search for it
before assuming.

```
Incoming: "Continue the TAYA Jira integration"
→ search_context({ query: "TAYA Jira integration", tags: ["taya", "jira"] })
```

Named entities are the clearest signal that prior work exists in memory.
Never assume you know the current state of a named system without checking.

---

### Trigger 3 — You feel uncertain or would have to guess
If you catch yourself about to write a value, URL, credential format, decision,
or configuration detail that you're not 100% certain about in this session —
stop and search. Uncertainty is a read trigger.

```
Internal signal: "I think the API endpoint was /v2/... but I'm not sure"
→ search_context({ query: "API endpoint config", agent: "devops-agent" })
```

**Why:** Guessing when the answer exists in memory is the failure mode that
makes multi-agent systems unreliable. Prefer one extra search over one wrong assumption.

---

### Trigger 4 — Handoff received from another agent
When you receive a handoff message, always read state and search for the
outputs and decisions from the sending agent before continuing.

```
Handoff: "HANDOFF Scraper→Analyzer | run-042 | ✅ | 87 items | File: data/raw.json"
→ get_state("pipeline_run_042")
→ search_context({ query: "scraper decisions run 042", topK: 4 })
```

The handoff message is a pointer, not a full briefing. The full context lives
in memory.

---

### Trigger 5 — Resuming after a pause or session restart
If any signal suggests this task was interrupted (references to phases,
run IDs, "continue from where we left off", or prior session context),
read state and search before acting.

```
Incoming: "Resume the pipeline, we stopped at phase 3"
→ get_state("pipeline_current_phase")
→ search_context({ query: "phase 3 output decisions", topK: 5 })
```

---

## When to WRITE to memory

### Trigger A — Decision made with rationale
Any time you make a non-trivial choice — technology, approach, configuration,
architecture — write it with the reasoning. Future agents (and your future self)
need the *why*, not just the *what*.

```
write_context({
  topic: "Auth service — chose JWT over sessions",
  content: "Chose stateless JWT. Rationale: no shared session store needed. Refresh tokens in Redis, 7d TTL. Access tokens: 15min.",
  tags: ["auth", "architecture", "decision"],
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
  topic: "Scraper run 042 — 87 listings collected",
  content: "Raw file at data/raw.json. ZAP Imóveis. Filters: SP capital, 2+ bedrooms, < R$800k. Rate: 2 req/s, 0 blocks.",
  tags: ["scraper", "imoveis", "output"],
  importance: "high"
})

write_context({
  topic: "Production DB — connection string verified",
  content: "postgresql://prod-db.internal:5432/app — verified working 2025-06-01. Credentials in .env as DATABASE_URL.",
  tags: ["database", "config", "production"],
  importance: "critical"
})
```

---

### Trigger C — Discovery that changes understanding
If you learn something that updates prior assumptions — an API changed,
a config is different from what was documented, an edge case was found —
write it immediately, even if no action follows yet.

```
write_context({
  topic: "ZAP API — rate limit changed to 1 req/s",
  content: "As of 2025-06: rate limit tightened. Previous setting (2 req/s) causes 429s. Updated scraper config.",
  tags: ["scraper", "zap", "config", "discovery"],
  importance: "high",
  ttl_days: 30
})
```

---

### Trigger D — Before ending your turn in a pipeline
Before passing control to the next agent or completing your turn in a
multi-step pipeline, write your state. Think of it as "committing" your work.
The sequence is always: **write output chunk → update state → send handoff**.

```
# Step 1 — persist your output
write_context({
  topic: "Analyzer run 042 — shortlist produced",
  content: "214 listings analyzed. Shortlist of 12 at data/shortlist.json. Criteria: price/m² < median, transport score > 7, no legal flags.",
  tags: ["analyzer", "imoveis", "output"],
  importance: "high"
})

# Step 2 — update pipeline state
set_state("pipeline_current_phase", {
  phase: "notification",
  step: 3,
  input_file: "data/shortlist.json",
  agent: "notifier-agent",
  started_at: "2025-06-01T14:00:00Z"
})

# Step 3 — send minimal handoff (the detail is in memory)
# HANDOFF Analyzer→Notifier | run-042 | ✅ | 12 shortlisted | File: data/shortlist.json
```

**Why this order:** if the handoff is sent before the write, the receiving agent
may search memory before the chunk exists and proceed with incomplete context.

---

## The deduplication rule — always search before writing

Before writing a new chunk, search for an existing one on the same topic.
If a chunk already exists with score > 1.5, **update by deleting and rewriting**
rather than creating a duplicate.

```
# Before writing about "Jira config":
results = search_context({ query: "Jira config endpoint token", topK: 3, min_score: 1.5 })

if results:
    delete_context(results[0].id)   # remove stale version

write_context({ topic: "Jira config — endpoint and token", ... })
```

Duplicate chunks fragment knowledge and produce contradictory search results.
One chunk per topic, kept current.

---

## Tag discipline — the contract between agents

Tags are how agents find each other's work. A tag written as `auth` and
searched as `authentication` produces no match. Tags must be agreed upon
and used consistently across all agents in a pipeline.

**Principles:**
- Use short, lowercase, hyphen-free terms: `auth`, `jira`, `scraper`, not `authentication-service`
- Prefer the canonical project or system name: `taya`, `zap`, `terminalos`
- Include the type of chunk: `decision`, `config`, `output`, `discovery`
- Never invent a new tag when an existing one covers it

**At the start of a project, define your tag vocabulary and put it in state:**
```
get_state("project_tags")
```
If it doesn't exist, define it and write it:
```
set_state("project_tags", ["auth", "jira", "scraper", "imoveis", "taya", "decision", "config", "output", "discovery"])
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
- Rate limit observations that change frequently (`ttl_days: 7–14`)
- A/B test results tied to a specific run (`ttl_days: 30`)
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

**Don't ignore low-score results.** A result with score 0.4 might still be
the only chunk on a topic. Read the top result even when scores are low —
just weight it accordingly.

---

## Quick reference — read/write decision

```
New task arrives
  └─ search_context (2-3 queries) → incorporate → act

Named entity in input
  └─ search_context (entity name + tags)

Feeling uncertain
  └─ search_context (topic of uncertainty)

Handoff received
  └─ get_state (run/pipeline ID) + search_context

Decision made
  └─ write_context (topic, content with rationale, tags, importance: high/critical)

Subtask complete
  └─ write_context (output description + file path + key facts)

Discovery made
  └─ write_context (what changed + impact, ttl_days if temporary)

Turn ending in pipeline
  └─ write_context (output) → set_state (next phase + agent) → send handoff

Before writing
  └─ search_context first → delete stale → write fresh
```