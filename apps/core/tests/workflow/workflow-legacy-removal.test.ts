import { describe, expect, it } from "bun:test";
import path from "node:path";

const REMOVED_PATHS = [
  "src/workflow/workflow-service.ts",
  "src/workflow/workflow-scheduler.ts",
  "src/workflow/workflow-store.ts",
  "src/workflow/workflow-store-queries.ts",
  "src/workflow/types.ts",
  "src/tool-server/tools/workflow.ts",
  "src/tools/workflow/workflow.ts",
] as const;

describe("legacy workflow removal", () => {
  it("keeps the V2/V3 service, scheduler, stores, types, and callables absent", async () => {
    for (const relativePath of REMOVED_PATHS) {
      expect(await Bun.file(path.join(import.meta.dir, "../..", relativePath)).exists()).toBe(
        false,
      );
    }
  });
});
