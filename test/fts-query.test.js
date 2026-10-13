import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildFtsQuery, extractTerms } from "../src/store/fts-query.js";

// Queries that broke the 0.0.x sanitizer (FTS5 syntax errors) plus edge cases.
const NASTY = [
  "What did we decide about auth?",
  "what's the user's token",
  "staging-deploy config",
  "node.js version",
  "api/v2 endpoint",
  "AND OR NOT",
  "NEAR(a b)",
  "topic:auth",
  'say "hello',
  "decisão de autenticação, JWT",
  "C++ / C# * ^ ( ) { } [ ] : ; ! @ # $ % & = + ~ ` |",
  "🚀 deploy 🔥",
  "日本語のテキスト",
  "-leading dash",
  "a",
  "",
  "    ",
  "???",
];

function ftsDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE VIRTUAL TABLE t USING fts5(body, tokenize='unicode61 remove_diacritics 2');`);
  db.prepare("INSERT INTO t(body) VALUES (?)").run("Decisão de autenticação: usamos JWT. The staging deploy uses node.js 22.");
  return db;
}

test("buildFtsQuery never produces an FTS5 syntax error", () => {
  const db = ftsDb();
  for (const q of NASTY) {
    const match = buildFtsQuery(q);
    if (match === null) continue;
    assert.doesNotThrow(() => db.prepare("SELECT * FROM t WHERE t MATCH ?").all(match), `query: ${q}`);
  }
});

test("natural-language queries still match the right document", () => {
  const db = ftsDb();
  for (const q of ["What did we decide about autenticação?", "staging-deploy", "node.js", "decisao autenticacao", "DECISÃO"]) {
    const rows = db.prepare("SELECT * FROM t WHERE t MATCH ?").all(buildFtsQuery(q));
    assert.equal(rows.length, 1, `query: ${q}`);
  }
});

test("stopwords are removed unless nothing else remains", () => {
  assert.deepEqual(extractTerms("What did we decide about the auth?"), ["decide", "auth"]);
  assert.deepEqual(extractTerms("qual é a decisão sobre o banco?"), ["decisão", "banco"]);
  assert.deepEqual(extractTerms("the and or"), ["the", "and", "or"]);
  assert.deepEqual(extractTerms("phase 3 of run 7 a"), ["phase", "3", "run", "7"]);
});

test("empty or symbol-only queries return null", () => {
  assert.equal(buildFtsQuery(""), null);
  assert.equal(buildFtsQuery("   "), null);
  assert.equal(buildFtsQuery("???"), null);
  assert.equal(buildFtsQuery(undefined), null);
});

test("terms are deduplicated and capped", () => {
  const q = Array.from({ length: 100 }, (_, i) => `term${i} term${i}`).join(" ");
  assert.equal(extractTerms(q).length, 32);
});
