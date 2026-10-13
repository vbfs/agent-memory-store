/**
 * agent-memory-store MCP server (stdio).
 *
 * Tools:
 *   search_context  — hybrid search (keyword + semantic) over memories
 *   write_context   — create or update a memory
 *   read_context    — full text of one memory
 *   list_context    — inventory (metadata only)
 *   delete_context  — remove a memory
 *   get_state       — read a shared state value (+ version)
 *   set_state       — write a shared state value (optional compare-and-set)
 *
 * Environment:
 *   AGENT_STORE_PATH    store directory (default: ./.agent-memory-store)
 *   AGENT_MEMORY_MODEL  embedding model key, or "none" for keyword-only
 *   AGENT_MEMORY_AGENT  default agent id for writes (default: "global")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import path from "path";
import { z } from "zod/v4";
import { MemoryStore, MemoryError, IMPORTANCE } from "./store/memory-store.js";
import { createEmbedder } from "./embeddings.js";
import { migrateLegacyFiles } from "./migrate.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const STORE_DIR = path.resolve(process.env.AGENT_STORE_PATH || path.join(process.cwd(), ".agent-memory-store"));
const DEFAULT_AGENT = process.env.AGENT_MEMORY_AGENT || "global";

const INSTRUCTIONS = `Persistent memory shared by every agent working in this project.
- Before acting on a task, call search_context with what you need to know (decisions, conventions, prior outputs). Queries can be in any language.
- After a decision, discovery or output others will need, call write_context with a specific topic, the content with its rationale, and a few lowercase tags.
- To change an existing memory, pass its id to write_context (updates in place). If write_context reports possible duplicates, update one of them instead of keeping both.
- Use get_state/set_state for small mutable values (phase, run id, flags). Pass expected_version to set_state when several agents may write the same key.
- Never store secrets; store where they live instead.`;

const store = MemoryStore.open(path.join(STORE_DIR, "store.db"), { embedder: createEmbedder() });
await migrateLegacyFiles(store, STORE_DIR);

const server = new McpServer({ name: "agent-memory-store", version }, { instructions: INSTRUCTIONS });

// ─── Formatting helpers ─────────────────────────────────────────────────────

function text(body) {
  return { content: [{ type: "text", text: body }] };
}

function errorResult(err) {
  const msg = err instanceof MemoryError ? err.message : `Internal error: ${err.message}`;
  return { content: [{ type: "text", text: msg }], isError: true };
}

/** Wraps a handler so failures become actionable tool errors, never crashes. */
function safe(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      if (!(err instanceof MemoryError)) {
        process.stderr.write(`[agent-memory-store] ${err.stack || err.message}\n`);
      }
      return errorResult(err);
    }
  };
}

function day(iso) {
  return iso ? iso.slice(0, 10) : "";
}

function metaLine(m, extra = []) {
  const parts = [`id: ${m.id}`, ...extra];
  if (m.tags.length) parts.push(`tags: ${m.tags.join(", ")}`);
  parts.push(m.importance);
  parts.push(`by ${m.updatedBy}`);
  parts.push(`updated ${day(m.updatedAt)} (v${m.version})`);
  if (m.expiresAt) parts.push(`expires ${day(m.expiresAt)}`);
  return parts.join(" · ");
}

function snippet(content, maxChars) {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars).trimEnd()}… [+${content.length - maxChars} chars — read_context for full text]`;
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const tagsSchema = z.array(z.string()).optional();
const dateSchema = (what) => z.string().optional().describe(`ISO 8601 date/time; ${what}`);

// ─── search_context ─────────────────────────────────────────────────────────

server.registerTool(
  "search_context",
  {
    title: "Search memory",
    description:
      "Search shared memory with hybrid ranking (keyword BM25 + multilingual semantic similarity). " +
      "Call at the start of a task to find prior decisions, conventions and outputs. " +
      "Results show a snippet; use read_context for the full text.",
    inputSchema: {
      query: z.string().min(1).describe("What you need to know, in natural language (any language)."),
      tags: tagsSchema.describe("Only memories with at least one of these tags."),
      agent: z.string().optional().describe("Only memories created by this agent id."),
      since: dateSchema("only memories updated at or after this time"),
      until: dateSchema("only memories updated at or before this time"),
      top_k: z.number().int().min(1).max(50).optional().describe("Max results (default 6)."),
      min_score: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Drop results below this rank-based score (0–1, default 0)."),
      search_mode: z
        .enum(["hybrid", "bm25", "semantic"])
        .optional()
        .describe("hybrid (default), bm25 (exact keywords only) or semantic (meaning only)."),
      max_chars: z
        .number()
        .int()
        .min(100)
        .max(20000)
        .optional()
        .describe("Max characters of content shown per result (default 1000)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  safe(async ({ query, tags, agent, since, until, top_k, min_score, search_mode, max_chars }) => {
    const { mode, results } = await store.search({
      query,
      tags,
      agent,
      since,
      until,
      limit: top_k ?? 6,
      minScore: min_score ?? 0,
      mode: search_mode ?? "hybrid",
    });
    if (results.length === 0) return text(`No memories found (${mode} search).`);
    const limit = max_chars ?? 1000;
    const blocks = results.map((r, i) => {
      const scores = [`score ${r.score.toFixed(2)}`];
      if (r.similarity != null) scores.push(`similarity ${r.similarity.toFixed(2)}`);
      return `[${i + 1}] ${r.topic}\n${metaLine(r, scores)}\n${snippet(r.content, limit)}`;
    });
    return text(`${results.length} result(s), ${mode} search:\n\n${blocks.join("\n\n")}`);
  }),
);

// ─── write_context ──────────────────────────────────────────────────────────

server.registerTool(
  "write_context",
  {
    title: "Write memory",
    description:
      "Save a memory other agents (and future sessions) will need: a decision with its rationale, an output and where it lives, or a discovery. " +
      "Without id it creates a new memory; with id it updates that memory in place (fields you omit keep their values). " +
      "The response lists possible duplicates — prefer updating them over creating near-copies.",
    inputSchema: {
      topic: z.string().min(1).describe('Short, specific title, e.g. "Auth — chose JWT over sessions".'),
      content: z.string().min(1).describe("The memory in markdown. Include the why, not just the what."),
      id: z
        .string()
        .optional()
        .describe("Id of the memory to update. You may also choose a stable id (e.g. \"auth-decision\") to create one."),
      tags: tagsSchema.describe("A few short lowercase tags, e.g. [\"auth\", \"decision\"]. Replaces existing tags on update."),
      importance: z.enum(IMPORTANCE).optional().describe("low | medium (default) | high | critical."),
      agent: z.string().optional().describe("Your agent id (e.g. \"backend-agent\")."),
      ttl_days: z
        .number()
        .positive()
        .nullable()
        .optional()
        .describe("Expire after this many days. Omit for permanent; null removes an existing expiry."),
      expected_version: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Only write if the memory's current version matches (0 = must not exist). Prevents overwriting another agent's change."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  safe(async ({ topic, content, id, tags, importance, agent, ttl_days, expected_version }) => {
    const m = await store.write({
      id,
      topic,
      content,
      tags,
      importance,
      agent: agent ?? DEFAULT_AGENT,
      ttlDays: ttl_days,
      expectedVersion: expected_version,
    });
    const lines = [`${m.created ? "Created" : "Updated"} memory ${m.id} (v${m.version}): "${m.topic}"`];
    if (m.duplicates.length) {
      lines.push("", "Possible duplicates — consider updating one of these (write_context with its id) and deleting the other:");
      for (const d of m.duplicates) lines.push(`- ${d.id}: "${d.topic}" (${d.reason})`);
    }
    if (m.content.length > 2000) {
      lines.push("", "Note: only the first ~2000 characters are used for semantic search; keyword search covers the full text. Consider splitting long content.");
    }
    return text(lines.join("\n"));
  }),
);

// ─── read_context ───────────────────────────────────────────────────────────

server.registerTool(
  "read_context",
  {
    title: "Read memory",
    description: "Return the full content and metadata of one memory by id.",
    inputSchema: { id: z.string().min(1).describe("Memory id from search_context or list_context.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  safe(async ({ id }) => {
    const m = store.get(id);
    if (!m) return errorResult(new MemoryError("NOT_FOUND", `No memory with id "${id}".`));
    return text(`# ${m.topic}\n${metaLine(m, [`created ${day(m.createdAt)}`])}\n\n${m.content}`);
  }),
);

// ─── list_context ───────────────────────────────────────────────────────────

server.registerTool(
  "list_context",
  {
    title: "List memories",
    description: "List memories newest first (metadata only, no content). Use for inventory and cleanup.",
    inputSchema: {
      agent: z.string().optional().describe("Only memories created by this agent id."),
      tags: tagsSchema.describe("Only memories with at least one of these tags."),
      since: dateSchema("only memories updated at or after this time"),
      until: dateSchema("only memories updated at or before this time"),
      limit: z.number().int().min(1).max(500).optional().describe("Page size (default 50)."),
      offset: z.number().int().min(0).optional().describe("Items to skip (default 0)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  safe(async ({ agent, tags, since, until, limit, offset }) => {
    const off = offset ?? 0;
    const { total, items } = store.list({ agent, tags, since, until, limit: limit ?? 50, offset: off });
    if (total === 0) return text("No memories found.");
    const lines = items.map((m) => `- ${m.topic}\n  ${metaLine(m, [`${m.chars} chars`])}`);
    const end = off + items.length;
    const more = end < total ? `\n\nMore available: call again with offset ${end}.` : "";
    return text(`Memories ${items.length ? off + 1 : 0}–${end} of ${total}:\n${lines.join("\n")}${more}`);
  }),
);

// ─── delete_context ─────────────────────────────────────────────────────────

server.registerTool(
  "delete_context",
  {
    title: "Delete memory",
    description: "Permanently delete a memory by id. Use for wrong or obsolete memories (prefer updating when it is merely outdated).",
    inputSchema: { id: z.string().min(1).describe("Memory id to delete.") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  safe(async ({ id }) => {
    if (!store.delete(id)) return errorResult(new MemoryError("NOT_FOUND", `No memory with id "${id}".`));
    return text(`Deleted memory ${id}.`);
  }),
);

// ─── get_state ──────────────────────────────────────────────────────────────

server.registerTool(
  "get_state",
  {
    title: "Get state",
    description: "Read a shared state value (phase, run id, flags, counters) and its version.",
    inputSchema: { key: z.string().min(1).describe("State key.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  safe(async ({ key }) => {
    const s = store.getState(key);
    if (!s) return text(`State "${key}" is not set (version 0).`);
    return text(
      `State "${key}" (version ${s.version}, updated ${s.updatedAt}${s.updatedBy ? ` by ${s.updatedBy}` : ""}):\n${JSON.stringify(s.value, null, 2)}`,
    );
  }),
);

// ─── set_state ──────────────────────────────────────────────────────────────

server.registerTool(
  "set_state",
  {
    title: "Set state",
    description:
      "Write a shared state value (any JSON). Pass expected_version (from get_state; 0 = must not exist) to update only if nobody changed it meanwhile.",
    inputSchema: {
      key: z.string().min(1).describe('State key, e.g. "current_phase".'),
      value: z.any().describe("Any JSON value."),
      expected_version: z.number().int().min(0).optional().describe("Compare-and-set guard."),
      agent: z.string().optional().describe("Your agent id."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  safe(async ({ key, value, expected_version, agent }) => {
    const r = store.setState(key, value ?? null, { expectedVersion: expected_version, agent: agent ?? DEFAULT_AGENT });
    return text(`State "${key}" written (version ${r.version}).`);
  }),
);

// ─── Start ──────────────────────────────────────────────────────────────────

const shutdown = () => {
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
store.warmup();
