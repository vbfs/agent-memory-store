import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

/** Creates a temp directory and returns [dir, cleanup]. */
export function tempDir(prefix = "ams-test-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return [dir, () => rmSync(dir, { recursive: true, force: true })];
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
