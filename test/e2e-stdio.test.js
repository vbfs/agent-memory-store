import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tempDir, ROOT } from "./helpers.js";

let client;
let cleanup;

before(async () => {
  let dir;
  [dir, cleanup] = tempDir();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings", path.join(ROOT, "src/index.js")],
    env: { ...process.env, AGENT_STORE_PATH: dir, AGENT_MEMORY_MODEL: "hash", AGENT_MEMORY_AGENT: "e2e-agent" },
    stderr: "ignore",
  });
  client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  cleanup?.();
});

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  return { text: res.content[0].text, isError: res.isError === true };
}

test("exposes the 7 tools with annotations and server instructions", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["delete_context", "get_state", "list_context", "read_context", "search_context", "set_state", "write_context"],
  );
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.search_context.annotations.readOnlyHint, true);
  assert.equal(byName.delete_context.annotations.destructiveHint, true);
  assert.match(client.getInstructions(), /search_context/);
});

test("full memory workflow over MCP", async () => {
  const w = await call("write_context", {
    topic: "Auth — chose JWT over sessions",
    content: "Stateless JWT (RS256). Refresh tokens in Redis, 7d TTL.",
    tags: ["auth", "decision"],
    importance: "critical",
  });
  assert.equal(w.isError, false);
  const id = w.text.match(/memory (\S+) \(v1\)/)[1];

  // The exact query that crashed 0.0.9 with an FTS5 syntax error.
  const s = await call("search_context", { query: "What did we decide about auth?" });
  assert.equal(s.isError, false);
  assert.match(s.text, /Auth — chose JWT over sessions/);
  assert.match(s.text, new RegExp(`id: ${id}`));
  assert.match(s.text, /by e2e-agent/);

  for (const query of ["staging-deploy?", "node.js", "AND OR NOT", "what's the user's token", "\"unterminated"]) {
    assert.equal((await call("search_context", { query })).isError, false, query);
  }

  const dup = await call("write_context", { topic: "auth — chose jwt over sessions", content: "copy" });
  assert.match(dup.text, /Possible duplicates/);
  assert.match(dup.text, new RegExp(id));

  const upd = await call("write_context", { id, topic: "Auth — chose JWT over sessions", content: "Now PASETO v4.", expected_version: 1 });
  assert.match(upd.text, /Updated memory .* \(v2\)/);
  const conflict = await call("write_context", { id, topic: "x", content: "y", expected_version: 1 });
  assert.equal(conflict.isError, true);
  assert.match(conflict.text, /Version conflict/);

  const r = await call("read_context", { id });
  assert.match(r.text, /Now PASETO v4\./);
  assert.match(r.text, /\(v2\)/);

  const l = await call("list_context", { tags: ["auth"] });
  assert.match(l.text, /of 1/);

  const secret = await call("write_context", { topic: "keys", content: "OPENAI sk-proj-abcdefghijklmnopqrstuvwxyz123456" });
  assert.equal(secret.isError, true);
  assert.match(secret.text, /Refused/);

  assert.equal((await call("delete_context", { id })).isError, false);
  assert.equal((await call("read_context", { id })).isError, true);
  assert.equal((await call("delete_context", { id })).isError, true);
});

test("state with compare-and-set over MCP", async () => {
  assert.match((await call("get_state", { key: "phase" })).text, /not set \(version 0\)/);
  assert.match((await call("set_state", { key: "phase", value: { step: 1 }, expected_version: 0 })).text, /version 1/);
  const conflict = await call("set_state", { key: "phase", value: { step: 9 }, expected_version: 0 });
  assert.equal(conflict.isError, true);
  const g = await call("get_state", { key: "phase" });
  assert.match(g.text, /version 1/);
  assert.match(g.text, /"step": 1/);
});

test("invalid arguments return tool errors, not crashes", async () => {
  const bad = await call("search_context", { query: "x", since: "yesterday-ish" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /ISO 8601/);
  const ok = await call("search_context", { query: "still alive?" });
  assert.equal(ok.isError, false);
});
