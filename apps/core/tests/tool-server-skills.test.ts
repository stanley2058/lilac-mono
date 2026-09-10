import { describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Panic } from "better-result";

import { Skills } from "../src/tool-server/tools/skills";
import { bindRequestInvocationCwd } from "../src/tool-server/request-invocation-cwd";

describe("tool-server skills", () => {
  it("declares concise positional inputs", async () => {
    const entries = await new Skills().list();

    expect(
      entries.map(({ callableId, primaryPositional }) => ({ callableId, primaryPositional })),
    ).toEqual([
      { callableId: "skills.list", primaryPositional: { field: "query" } },
      { callableId: "skills.read", primaryPositional: { field: "name" } },
    ]);
  });

  it("returns semantic usage failures for invalid input", async () => {
    expect(await new Skills().call("skills.list", { limit: 0 })).toMatchObject({
      status: "error",
      error: { kind: "usage", code: "invalid_input", retryable: false },
    });
  });

  it("preserves Panic from skill discovery", async () => {
    const panic = new Panic({ message: "skill discovery invariant failed" });
    const access = spyOn(fs, "access").mockRejectedValue(panic);
    try {
      const [settled] = await Promise.allSettled([new Skills().call("skills.list", {})]);

      expect(settled?.status).toBe("rejected");
      if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
    } finally {
      access.mockRestore();
    }
  });

  it("preserves Panic from skill file reads", async () => {
    const panic = new Panic({ message: "skill file invariant failed" });
    const file = spyOn(Bun, "file").mockImplementation(() => {
      throw panic;
    });
    try {
      const [settled] = await Promise.allSettled([
        new Skills().call("skills.read", { name: "coding-agent" }),
      ]);

      expect(settled?.status).toBe("rejected");
      if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
    } finally {
      file.mockRestore();
    }
  });

  it("removes both legacy read tools", async () => {
    for (const callable of ["skills.brief", "skills.full"]) {
      expect(await new Skills().call(callable, { name: "coding-agent" })).toMatchObject({
        status: "error",
        error: { kind: "not_found", code: "unknown_callable" },
      });
    }
  });

  it("lists and reads manual skills from caller cwd without a workspace manifest", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-cwd-skills-"));
    const name = "manual-cwd-test-skill";
    const directory = path.join(cwd, ".agents", "skills", name);
    const location = path.join(directory, "SKILL.md");
    const content = `---
name: ${name}
description: A manual skill in the caller directory.
disable-model-invocation: true
metadata:
  author: test
---

${"Complete instructions.\n".repeat(12_000)}Last instruction.
`;
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(location, content);
      const tool = new Skills();
      const opts = { context: { cwd } };
      const listed = await tool.call("skills.list", { sources: "agent-project" }, opts);
      expect(listed).toMatchObject({
        status: "ok",
        value: {
          skills: [{ name, location, source: "agent-project" }],
        },
      });
      bindRequestInvocationCwd(opts.context, cwd);
      opts.context.cwd = path.join(cwd, "canonical-workspace");
      expect(await tool.call("skills.list", { sources: "agent-project" }, opts)).toEqual(listed);
      const read = await tool.call("skills.read", { name }, opts);
      expect(read.status).toBe("ok");
      if (read.status !== "ok") throw new Error(read.error.message);
      if (typeof read.value !== "object" || read.value === null) {
        throw new Error("Expected a skill read object");
      }
      expect(Object.keys(read.value)).toEqual(["path", "length", "metadata", "content"]);
      expect(read.value).toEqual({
        path: location,
        length: content.length,
        metadata: {
          name,
          description: "A manual skill in the caller directory.",
          "disable-model-invocation": true,
          metadata: { author: "test" },
        },
        content,
      });
      const elsewhere = await tool.call(
        "skills.list",
        { query: name },
        {
          context: { cwd: path.join(cwd, "elsewhere") },
        },
      );
      expect(elsewhere).toMatchObject({ status: "ok", value: { skills: [] } });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
