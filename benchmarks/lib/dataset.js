/**
 * LongMemEval-S loader with local caching, plus the official corpus
 * construction rules (src/retrieval/run_retrieval.py, process_item_flat_index).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "longmemeval_s_cleaned.json");
const DATASET_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";

export async function loadDataset() {
  if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  mkdirSync(CACHE_DIR, { recursive: true });
  process.stderr.write("[bench] Downloading LongMemEval-S (cleaned) from Hugging Face...\n");
  const res = await fetch(DATASET_URL);
  if (!res.ok) throw new Error(`Failed to download dataset: ${res.status} ${res.statusText}`);
  const text = await res.text();
  writeFileSync(CACHE_FILE, text);
  return JSON.parse(text);
}

/**
 * Official exclusions: abstention questions and questions without any
 * user-side evidence turn.
 */
export function isEvaluable(q) {
  if (q.question_id.includes("_abs")) return false;
  return q.haystack_sessions.some((s) => s.some((t) => t.role === "user" && t.has_answer));
}

/** "2023/05/20 (Sat) 02:21" → ISO string */
export function parseDate(s) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})(?: \(\w+\))?(?: (\d{2}):(\d{2}))?/.exec(s || "");
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0))).toISOString();
}

/**
 * Session-granularity corpus. Official: user turns only, joined with spaces;
 * a session is gold if its id contains "answer" and one of its user turns
 * has has_answer=true. `withAssistant` adds assistant turns (non-official
 * variant, reported separately).
 *
 * @returns {{ docs: Array<{id, text, date}>, gold: Set<string> }}
 */
export function buildSessionCorpus(q, { withAssistant = false } = {}) {
  const docs = [];
  const gold = new Set();
  q.haystack_sessions.forEach((turns, i) => {
    const id = q.haystack_session_ids[i];
    const text = turns
      .filter((t) => withAssistant || t.role === "user")
      .map((t) => t.content)
      .join(" ");
    docs.push({ id, text, date: parseDate(q.haystack_dates?.[i]) });
    if (id.includes("answer") && turns.some((t) => t.role === "user" && t.has_answer)) gold.add(id);
  });
  return { docs, gold };
}
