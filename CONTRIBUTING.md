# Contributing

## Setup

```bash
git clone https://github.com/vbfs/agent-memory-store
cd agent-memory-store
npm install
npm test          # unit + end-to-end (stdio) + multi-process tests, no model download
AMS_MODEL_TESTS=1 npm test   # also end-to-end with the real embedding model
```

Requires Node.js >= 22.13 (built-in `node:sqlite`).

## Layout

```
src/
  index.js               MCP server: tool schemas, formatting, errors
  embeddings.js          Embedder interface, local models, HashEmbedder (tests)
  migrate.js             One-time import of the legacy markdown file store
  store/
    memory-store.js      MemoryStore: schema + migrations, write/search/list/state
    fts-query.js         Safe FTS5 query builder (never a syntax error)
    vector-index.js      In-memory exact vector index
    secrets.js           Credential detection on write
test/                    node:test suites (run with `npm test`)
benchmarks/              bench (quality + speed), golden set, LongMemEval — all use MemoryStore
```

There is one implementation of storage and ranking (`MemoryStore`). The MCP
server, the tests and every benchmark use it — never copy search logic into a
benchmark.

## Changing ranking or the embedding model

Run before and after, and include both outputs in the PR:

```bash
npm run bench                 # quality + speed, ~30 s
npm run bench:tune-fusion     # if you touched fusion or ranking
```

Report the metrics exactly as printed. Do not compare against numbers from
other systems unless they use the same dataset, granularity and metric.

## Schema changes

Bump `SCHEMA_VERSION` in `src/store/memory-store.js`, add a migration step
that runs inside the existing transaction, and add a test that opens a
database created with the previous schema.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`,
`docs:`, `test:`, `perf:`, `refactor:`.

## Reporting issues

Include the Node.js version, OS, `AGENT_MEMORY_MODEL` (if set), the tool call
and arguments, and the server's stderr output.
