#!/usr/bin/env node
/**
 * Entry point. node:sqlite is stable in practice but still prints an
 * ExperimentalWarning on start, which MCP clients surface as server errors.
 * Filter only that warning, then load the server (dynamically, so the filter
 * is in place before node:sqlite is loaded).
 */
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
  if (type === "ExperimentalWarning" && String(warning?.message ?? warning).includes("SQLite")) return;
  return emitWarning.call(this, warning, ...args);
};

// stdout carries the MCP protocol; a stray console.log from any dependency
// would corrupt it. Route general logging to stderr.
console.log = console.info = console.debug = console.error;

await import("./server.js");
