#!/usr/bin/env node
/**
 * agent-memory-store MCP server entry point.
 *
 * Exposes 7 tools to any MCP-compatible client (Claude Code, opencode, etc.):
 *   search_context  — Hybrid search (BM25 + semantic) over stored chunks
 *   write_context   — persist a new memory chunk
 *   read_context    — retrieve a chunk by ID
 *   list_context    — list chunk metadata (no body)
 *   delete_context  — remove a chunk by ID
 *   get_state       — read a session state variable
 *   set_state       — write a session state variable
 *
 * Usage:
 *   npx agent-memory-store
 *   AGENT_STORE_PATH=/your/project/.agent-memory-store npx agent-memory-store
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import {
  searchChunks,
  writeChunk,
  readChunk,
  deleteChunk,
  listChunks,
  getState,
  setState,
  initStore,
} from "./store.js";

const { version } = JSON.parse(
  await import("fs").then((fs) =>
    fs.promises.readFile(new URL("../package.json", import.meta.url), "utf8"),
  ),
);

// Initialize database, run migration, warm up embeddings
await initStore();

const server = new McpServer({
  name: "context-store",
  version,
});

// ─── search_context ───────────────────────────────────────────────────────────

server.tool(
  "search_context",
  [
    "Search stored memory chunks using hybrid ranking (BM25 + semantic similarity).",
    "Call this at the start of any task to retrieve relevant prior knowledge,",
    "decisions, and outputs before generating a response.",
    "Supports three modes: 'hybrid' (default, best quality), 'bm25' (keyword-only), 'semantic' (meaning-only).",
  ].join(" "),
  {
    query: z
      .string()
      .describe(
        "Search query. Be specific — use canonical terms your team agreed on.",
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Narrow results to chunks matching any of these tags."),
    agent: z
      .string()
      .optional()
      .describe("Narrow results to chunks written by a specific agent ID."),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Maximum number of results to return (default: 6)."),
    min_score: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Minimum relevance score. Lower = more permissive (default: 0.1).",
      ),
    search_mode: z
      .enum(["hybrid", "bm25", "semantic"])
      .optional()
      .describe(
        "Search strategy: 'hybrid' (BM25 + semantic, default), 'bm25' (keyword only), 'semantic' (embedding similarity only).",
      ),
  },
  async ({ query, tags, agent, top_k, min_score, search_mode }) => {
    const results = await searchChunks({
      query,
      tags: tags ?? [],
      agent,
      topK: top_k ?? 6,
      minScore: min_score ?? 0.1,
      mode: search_mode ?? "hybrid",
    });

    if (results.length === 0) {
      return { content: [{ type: "text", text: "No matching chunks found." }] };
    }

    const body = results
      .map((r) =>
        [
          `### [score: ${r.score}] ${r.topic}`,
          `**id:** \`${r.id}\` | **agent:** ${r.agent} | **tags:** ${r.tags.join(", ")} | **importance:** ${r.importance} | **updated:** ${r.updated}`,
          "",
          r.content,
        ].join("\n"),
      )
      .join("\n\n---\n\n");

    return { content: [{ type: "text", text: body }] };
  },
);

// ─── write_context ────────────────────────────────────────────────────────────

server.tool(
  "write_context",
  [
    "Persist a memory chunk to the database.",
    "Call this after completing a subtask, making a key decision,",
    "or producing output that downstream agents will need.",
    "Embeddings are computed automatically in the background for semantic search.",
  ].join(" "),
  {
    topic: z
      .string()
      .describe(
        'Short, specific title. e.g. "Auth service — JWT decision" not "decision".',
      ),
    content: z
      .string()
      .describe(
        "Chunk body in markdown. Include rationale, not just conclusions.",
      ),
    agent: z
      .string()
      .optional()
      .describe(
        'Agent ID writing this chunk (e.g. "pm-agent", "scraper-agent").',
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        "Canonical tags for future retrieval. Use consistent terms across agents.",
      ),
    importance: z
      .enum(["low", "medium", "high", "critical"])
      .optional()
      .describe(
        "Importance level — affects future curation decisions (default: medium).",
      ),
    ttl_days: z
      .number()
      .positive()
      .optional()
      .describe("Auto-expiry in days. Omit for permanent storage."),
  },
  async ({ topic, content, agent, tags, importance, ttl_days }) => {
    const result = await writeChunk({
      topic,
      content,
      agent: agent ?? "global",
      tags: tags ?? [],
      importance: importance ?? "medium",
      ttlDays: ttl_days,
    });

    return {
      content: [
        {
          type: "text",
          text: `Chunk saved: id=\`${result.id}\` | topic="${result.topic}" | tags=[${result.tags.join(", ")}] | importance=${result.importance}`,
        },
      ],
    };
  },
);

// ─── read_context ─────────────────────────────────────────────────────────────

server.tool(
  "read_context",
  "Retrieve the full content of a specific chunk by its ID.",
  {
    id: z
      .string()
      .describe(
        "Chunk ID (10-char hex string from write_context or list_context).",
      ),
  },
  async ({ id }) => {
    const chunk = await readChunk(id);

    if (!chunk) {
      return {
        content: [{ type: "text", text: `No chunk found with id \`${id}\`.` }],
      };
    }

    const { meta, content } = chunk;
    const header = [
      `## ${meta.topic}`,
      `**id:** \`${meta.id}\` | **agent:** ${meta.agent} | **tags:** ${(meta.tags || []).join(", ")} | **importance:** ${meta.importance} | **updated:** ${meta.updated}`,
    ].join("\n");

    return { content: [{ type: "text", text: `${header}\n\n${content}` }] };
  },
);

// ─── list_context ─────────────────────────────────────────────────────────────

server.tool(
  "list_context",
  "List all stored chunks (metadata only, no body). Useful for inventory and curation.",
  {
    agent: z.string().optional().describe("Filter by agent ID."),
    tags: z.array(z.string()).optional().describe("Filter by tags."),
  },
  async ({ agent, tags }) => {
    const chunks = await listChunks({ agent, tags: tags ?? [] });

    if (chunks.length === 0) {
      return { content: [{ type: "text", text: "Memory store is empty." }] };
    }

    const lines = chunks.map(
      (c) =>
        `- \`${c.id}\` **${c.topic}** | agent:${c.agent} | tags:[${c.tags.join(", ")}] | ${c.importance} | ${c.updated}`,
    );

    return {
      content: [
        {
          type: "text",
          text: `${chunks.length} chunk(s) found:\n\n${lines.join("\n")}`,
        },
      ],
    };
  },
);

// ─── delete_context ───────────────────────────────────────────────────────────

server.tool(
  "delete_context",
  "Permanently delete a chunk by ID. Use to remove outdated or incorrect memory.",
  {
    id: z.string().describe("Chunk ID to delete."),
  },
  async ({ id }) => {
    const deleted = await deleteChunk(id);
    return {
      content: [
        {
          type: "text",
          text: deleted
            ? `Chunk \`${id}\` deleted.`
            : `No chunk found with id \`${id}\`.`,
        },
      ],
    };
  },
);

// ─── get_state ────────────────────────────────────────────────────────────────

server.tool(
  "get_state",
  "Read a pipeline state variable by key. Use to check progress, flags, and counters across agent turns.",
  {
    key: z.string().describe("State key to read."),
  },
  async ({ key }) => {
    const value = await getState(key);

    if (value === null) {
      return {
        content: [{ type: "text", text: `State key "${key}" not found.` }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text:
            typeof value === "string" ? value : JSON.stringify(value, null, 2),
        },
      ],
    };
  },
);

// ─── set_state ────────────────────────────────────────────────────────────────

server.tool(
  "set_state",
  "Write a pipeline state variable (any JSON-serializable value). Use to track progress, store flags, or pass structured data between agent turns.",
  {
    key: z
      .string()
      .describe('State key (e.g. "pipeline_status", "current_phase").'),
    value: z.any().describe("Any JSON-serializable value."),
  },
  async ({ key, value }) => {
    const result = await setState(key, value);
    return {
      content: [
        {
          type: "text",
          text: `State "${key}" written at ${result.updated}.`,
        },
      ],
    };
  },
);

// ─── Start server ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
