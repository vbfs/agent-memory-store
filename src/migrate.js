/**
 * Migration: legacy filesystem storage (<= 0.0.5, markdown files) → SQLite.
 *
 * Runs on startup when <storeDir>/chunks/ exists. Imports every chunk and
 * state entry into the store, then renames the legacy directories to
 * *_backup/ so the import never runs twice.
 */

import fs from "fs/promises";
import path from "path";

async function isDir(p) {
  return fs.stat(p).then((s) => s.isDirectory()).catch(() => false);
}

/**
 * @param {import("./store/memory-store.js").MemoryStore} store
 * @param {string} storeDir
 * @returns {Promise<boolean>} true if a migration ran
 */
export async function migrateLegacyFiles(store, storeDir) {
  const chunksDir = path.join(storeDir, "chunks");
  const stateDir = path.join(storeDir, "state");
  if (!(await isDir(chunksDir))) return false;

  process.stderr.write("[agent-memory-store] Migrating legacy file storage to SQLite...\n");
  const { default: matter } = await import("gray-matter");
  let chunkCount = 0;
  let stateCount = 0;

  for (const file of await fs.readdir(chunksDir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const raw = await fs.readFile(path.join(chunksDir, file), "utf8");
      const { data: meta, content } = matter(raw);
      if (meta.expires && new Date(meta.expires) < new Date()) continue;
      store.importMemory({
        id: String(meta.id || file.replace(/\.md$/, "")),
        topic: meta.topic || "Untitled",
        content: content.trim() || "(empty)",
        agent: meta.agent || "global",
        tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
        importance: meta.importance,
        createdAt: meta.updated ? new Date(meta.updated).toISOString() : undefined,
        updatedAt: meta.updated ? new Date(meta.updated).toISOString() : undefined,
        expiresAt: meta.expires || null,
      });
      chunkCount++;
    } catch (err) {
      process.stderr.write(`[agent-memory-store] Skipped ${file}: ${err.message}\n`);
    }
  }

  if (await isDir(stateDir)) {
    for (const file of await fs.readdir(stateDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const { key, value } = JSON.parse(await fs.readFile(path.join(stateDir, file), "utf8"));
        if (key && store.getState(key) === null) {
          store.setState(key, value);
          stateCount++;
        }
      } catch (err) {
        process.stderr.write(`[agent-memory-store] Skipped state ${file}: ${err.message}\n`);
      }
    }
    await fs.rename(stateDir, `${stateDir}_backup`).catch(() => {});
  }
  await fs.rename(chunksDir, `${chunksDir}_backup`).catch(() => {});

  process.stderr.write(
    `[agent-memory-store] Migration complete: ${chunkCount} memories, ${stateCount} state entries.\n`,
  );
  return true;
}
