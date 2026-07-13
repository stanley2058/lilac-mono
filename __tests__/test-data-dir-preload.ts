import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const testDataDir = mkdtempSync(path.join(tmpdir(), "lilac-test-data-"));
process.env.DATA_DIR = testDataDir;

process.once("exit", () => {
  rmSync(testDataDir, { recursive: true, force: true });
});
