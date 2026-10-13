// End-to-end with the real embedding model (downloads it on first run).
// Opt-in: AMS_MODEL_TESTS=1 npm test   (runs in CI's retrieval-quality job)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tempDir, ROOT } from "./helpers.js";

const enabled = process.env.AMS_MODEL_TESTS === "1";
let client;
let cleanup;

before(async () => {
  if (!enabled) return;
  let dir;
  [dir, cleanup] = tempDir();
  // No AGENT_MEMORY_MODEL: exercises the default model, as users get it.
  const env = { ...process.env, AGENT_STORE_PATH: dir };
  delete env.AGENT_MEMORY_MODEL;
  client = new Client({ name: "e2e-model", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "src/index.js")], env, stderr: "ignore" }));
});

after(async () => {
  await client?.close();
  cleanup?.();
});

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  return res.content[0].text;
}

test("cross-lingual hybrid search through the MCP server with the default model", { skip: !enabled, timeout: 600_000 }, async () => {
  await call("write_context", {
    topic: "Pagamentos — timeout do webhook de devolução PIX",
    content: "Aumentamos o timeout do webhook de devolução PIX de 10s para 20s porque o p99 do banco no sandbox é 14s.",
    tags: ["pix", "decision"],
  });
  await call("write_context", { topic: "Staging deploy", content: "Staging auto-syncs in ArgoCD on every merge to main." });

  // The model loads in the background; wait until searches run in hybrid mode.
  let text = "";
  for (let i = 0; i < 600 && !text.includes("hybrid search"); i++) {
    text = await call("search_context", { query: "How long do we wait for the PIX refund webhook?" });
    if (!text.includes("hybrid search")) await new Promise((r) => setTimeout(r, 1000));
  }
  assert.match(text, /hybrid search/);
  assert.match(text.split("\n\n")[1], /webhook de devolução PIX/, "Portuguese memory ranks first for an English question");
  assert.match(text, /similarity 0\.\d\d/);

  const dup = await call("write_context", {
    topic: "PIX refund webhook timeout",
    content: "The PIX refund webhook timeout was raised from 10s to 20s because the bank sandbox p99 is 14s.",
  });
  assert.match(dup, /Possible duplicates/, "cross-lingual near-duplicate is reported");
});
