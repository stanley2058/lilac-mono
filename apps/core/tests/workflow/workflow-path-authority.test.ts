import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { authorizeWorkflowPathInput } from "../../src/workflow/workflow-path-authority";

describe("workflow Level-2 descriptor path authority", () => {
  it("never reopens a replaced intermediate parent for reads or writes", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-level2-parent-race-"));
    const root = path.join(temp, "workspace");
    const scratch = path.join(temp, "scratch");
    const parent = path.join(root, "nested");
    const parked = path.join(root, "nested-authorized");
    const deniedParent = path.join(temp, "denied-parent");
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(scratch);
    await fs.mkdir(deniedParent);
    await fs.writeFile(path.join(parent, "input.txt"), "authorized", "utf8");
    await fs.writeFile(path.join(deniedParent, "input.txt"), "denied", "utf8");
    await fs.writeFile(path.join(deniedParent, "output.txt"), "outside unchanged", "utf8");
    const rootStats = await fs.stat(root, { bigint: true });
    const policy = {
      canonicalCwd: root,
      canonicalCwdIdentity: {
        dev: rootStats.dev.toString(10),
        ino: rootStats.ino.toString(10),
      },
      canonicalScratchRoot: scratch,
    };
    let stop = false;
    const swapper = (async () => {
      while (!stop) {
        try {
          await fs.rename(parent, parked);
          await fs.symlink(deniedParent, parent);
          await Bun.sleep(0);
          await fs.rm(parent);
          await fs.rename(parked, parent);
        } catch {}
      }
    })();
    try {
      const reads = await Promise.allSettled(
        Array.from({ length: 100 }, async () => {
          const authorized = await authorizeWorkflowPathInput({
            callableId: "test.read",
            value: { path: "nested/input.txt" },
            policy,
            authority: {
              inputs: [{ field: "path", cardinality: "one", target: "read-file" }],
            },
          });
          try {
            return await fs.readFile(String(authorized.value.path), "utf8");
          } finally {
            await authorized.close();
          }
        }),
      );
      const readValues = reads.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(readValues.every((value) => value === "authorized")).toBe(true);
      expect(reads.some((result) => result.status === "rejected")).toBe(true);

      const writes = await Promise.allSettled(
        Array.from({ length: 100 }, async (_value, index) => {
          const authorized = await authorizeWorkflowPathInput({
            callableId: "test.write",
            value: { path: "nested/output.txt" },
            policy,
            authority: {
              inputs: [{ field: "path", cardinality: "one", target: "write-file" }],
            },
          });
          try {
            await fs.writeFile(String(authorized.value.path), `authorized-${index}`, "utf8");
          } finally {
            await authorized.close();
          }
        }),
      );
      expect(writes.some((result) => result.status === "rejected")).toBe(true);
      expect(await fs.readFile(path.join(deniedParent, "output.txt"), "utf8")).toBe(
        "outside unchanged",
      );
    } finally {
      stop = true;
      await swapper;
      if (
        await fs
          .lstat(parent)
          .then((stats) => stats.isSymbolicLink())
          .catch(() => false)
      ) {
        await fs.rm(parent);
      }
      if (
        await fs
          .stat(parked)
          .then(() => true)
          .catch(() => false)
      )
        await fs.rename(parked, parent);
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});
