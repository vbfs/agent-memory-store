# Contributing

Thank you for your interest in contributing to context-store!

## Getting started

```bash
git clone https://github.com/YOUR_USERNAME/context-store
cd context-store
npm install
```

## Running locally

```bash
# Start the MCP server (stdio mode)
npm start

# Run tests
npm test
```

## Project structure

```
src/
  bm25.js    — BM25 ranking engine (pure JS, no dependencies)
  store.js   — File-based persistence layer (chunks + state)
  index.js   — MCP server and tool definitions
```

## Adding a new tool

1. Add the business logic in `src/store.js`
2. Register the tool in `src/index.js` with a `server.tool()` call
3. Add a test in `src/__tests__/store.test.js`
4. Document the tool in the README Tools table

## Commit conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add expiry-based chunk pruning tool
fix: handle missing frontmatter gracefully
docs: add opencode configuration example
test: add BM25 score regression test
```

## Pull request checklist

- [ ] All existing tests pass (`npm test`)
- [ ] New functionality has tests
- [ ] README is updated if tools or configuration changed
- [ ] CHANGELOG entry added under `[Unreleased]`
- [ ] Code is in English (comments, variable names, tool descriptions)

## Reporting issues

Please include:

- Node.js version (`node --version`)
- `CONTEXT_STORE_PATH` value (if customized)
- The tool call and input that caused the issue
- Error message or unexpected output
