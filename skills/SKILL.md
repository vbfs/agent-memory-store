---
name: agent-memory
description: "How to use the shared agent memory (agent-memory-store MCP tools: search_context, write_context, read_context, list_context, delete_context, get_state, set_state). Use whenever these tools are available and you start a task, receive a handoff, are unsure about a project fact, make a decision, finish a piece of work others depend on, or discover something that changes prior assumptions."
---

# Shared agent memory

Your context window is temporary; the memory store is shared by every agent on
this project and survives sessions. Use it so no agent re-decides, re-discovers
or contradicts what another already settled.

## 1. Read before you act

At the start of a task, after a handoff, or whenever you are about to assume a
project fact (a convention, a decision, a config value, where something lives):

```
search_context({ query: "how do we run database migrations in production?" })
```

- Ask in natural language, in Portuguese or English — search is multilingual
  and also matches exact identifiers (`PAG-4821`, `orders.v1`, file paths).
- Run 1–3 focused queries rather than one vague one.
- Results show a snippet; call `read_context(id)` for the full text.
- `score` is relative ranking (1.0 = top for both keyword and semantic search);
  `similarity` is semantic closeness. Read the result before trusting it.
- Narrow with `tags`, `agent`, `since`/`until` when you know the scope.

## 2. Write what others will need

Write after a **decision** (with the why), an **output** (what and where), or a
**discovery** that changes assumptions. Do not write chat logs, plans you have
not executed, or anything only you need right now.

```
write_context({
  topic: "Payments — PIX refund webhook timeout set to 20s",
  content: "Raised from 10s to 20s: the bank's sandbox p99 is 14s (load test PAG-4821). Retries: 3, exponential backoff. Config: services/payments/config/pix.yaml.",
  tags: ["payments", "pix", "decision"],
  importance: "high"
})
```

- **Topic**: specific enough to be found six months from now by another agent.
- **Content**: facts, numbers, paths, and the reason. Under ~2000 characters
  (longer text is still keyword-searchable, but split it if you can).
- **Tags**: 1–4 short lowercase words. Check existing ones with `list_context`.
- **Importance**: `critical` = others will break things without it;
  `high` = changes how the next step runs; `medium` default; `low` = ephemeral.
- **Temporary facts** (rate limits, incident workarounds): set `ttl_days`.

## 3. Update, don't duplicate

When something changes, update the existing memory instead of adding a new one:

```
write_context({ id: "<id from search>", topic: "...", content: "<new full content>" })
```

`write_context` warns about possible duplicates (same topic or very similar
content). When it does, merge them: update one with the combined content and
`delete_context` the other. Use `delete_context` only for memories that are
wrong or obsolete.

When several agents may edit the same memory, pass `expected_version` (from
the `vN` shown in search/read results). On a conflict, re-read and retry.

## 4. Coordinate with state

`get_state` / `set_state` hold small mutable values: current phase, run id,
who owns what, counters. Not searchable — use `write_context` for knowledge.

To change shared state safely:

```
s = get_state({ key: "release_phase" })            // → version 3
set_state({ key: "release_phase", value: {...}, expected_version: 3 })
```

`expected_version: 0` means "only if nobody has set it yet" (claiming a task).

## 5. Handoffs

Finish in this order: `write_context` (your output) → `set_state` (next phase)
→ hand off with a short pointer. The receiving agent starts with `get_state` and
`search_context`, so the details live in memory, not in the message.

## 6. Never store secrets

The server rejects API keys, tokens, private keys and passwords in connection
strings. Write where the secret lives instead ("DATABASE_URL in Vault at
prod/payments").
