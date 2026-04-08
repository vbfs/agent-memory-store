/**
 * LongMemEval dataset loader with local caching.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "longmemeval_s_cleaned.json");

const DATASET_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";

/**
 * Downloads and caches the LongMemEval-S dataset (500 questions).
 *
 * @returns {Promise<Array>} Array of question objects
 */
export async function loadDataset() {
  if (existsSync(CACHE_FILE)) {
    process.stderr.write(`[bench] Loading cached dataset from ${CACHE_FILE}\n`);
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  process.stderr.write(
    `[bench] Downloading LongMemEval dataset from HuggingFace...\n`,
  );
  const res = await fetch(DATASET_URL);
  if (!res.ok) {
    throw new Error(`Failed to download dataset: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  writeFileSync(CACHE_FILE, text);
  process.stderr.write(`[bench] Dataset cached at ${CACHE_FILE}\n`);

  return JSON.parse(text);
}

/**
 * Extracts ground-truth relevant session IDs for a question.
 * A session is relevant if any of its turns has has_answer=true.
 *
 * @param {object} question - A question object from the dataset
 * @returns {Set<string>} Set of relevant session IDs (as string indices)
 */
export function getRelevantSessionIds(question) {
  const relevant = new Set();
  const sessions = question.haystack_sessions || [];

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const turns = Array.isArray(session) ? session : session.turns || [];
    for (const turn of turns) {
      if (turn.has_answer === true) {
        relevant.add(String(i));
        break;
      }
    }
  }

  return relevant;
}

/**
 * Converts haystack sessions to ingestible chunks (session-level granularity).
 * Each session becomes one chunk with all turns concatenated.
 *
 * @param {Array} sessions - haystack_sessions array
 * @returns {Array<{id: string, content: string}>}
 */
export function sessionsToChunks(sessions) {
  return sessions.map((session, i) => {
    const turns = Array.isArray(session) ? session : session.turns || [];
    const content = turns
      .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
      .join("\n");
    return { id: String(i), content };
  });
}

/**
 * Converts haystack sessions to ingestible chunks (turn-level granularity).
 * Each user turn becomes a separate chunk, tagged with its session index.
 *
 * @param {Array} sessions - haystack_sessions array
 * @returns {Array<{id: string, sessionId: string, content: string}>}
 */
export function sessionsToTurnChunks(sessions) {
  const chunks = [];
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const turns = Array.isArray(session) ? session : session.turns || [];
    let turnIdx = 0;
    for (const turn of turns) {
      if (turn.role === "user") {
        chunks.push({
          id: `${i}_${turnIdx}`,
          sessionId: String(i),
          content: turn.content,
        });
      }
      turnIdx++;
    }
  }
  return chunks;
}
