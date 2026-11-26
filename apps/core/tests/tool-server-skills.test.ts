import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

  it("offers surface-scoped skills only to requests from those clients", async () => {
    const native = { context: { cwd: process.cwd(), requestClient: "native" } };
    const discord = { context: { cwd: process.cwd(), requestClient: "discord" } };
    const tool = new Skills();
    const names = async (opts: typeof native) => {
      const listed = await tool.call("skills.list", { sources: "lilac-builtin" }, opts);
      if (listed.status !== "ok") throw new Error(listed.error.message);
      return (listed.value as { skills: { name: string }[] }).skills.map((skill) => skill.name);
    };
    expect(await names(native)).toContain("visualize");
    expect(await names(discord)).not.toContain("visualize");
    expect(await names(discord)).toContain("coding-agent");
    expect((await tool.call("skills.read", { name: "visualize" }, native)).status).toBe("ok");
    expect(await tool.call("skills.read", { name: "visualize" }, discord)).toMatchObject({
      status: "error",
      error: { kind: "not_found" },
    });
  });
  it("lists and reads native skills for delegated native requests", async () => {
    const tool = new Skills();
    for (const platform of ["native", "discord", undefined] as const) {
      const context = {
        cwd: process.cwd(),
        requestClient: "unknown",
        ...(platform ? { requestInitiator: { platform, userId: "user-1" } } : {}),
      };
      const listed = await tool.call("skills.list", { query: "visualize" }, { context });
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") throw new Error(listed.error.message);
      const expected = {
        skills: expect.arrayContaining([expect.objectContaining({ name: "visualize" })]),
      };
      if (platform === "native") expect(listed.value).toMatchObject(expected);
      else expect(listed.value).not.toMatchObject(expected);
      const read = await tool.call("skills.read", { name: "visualize" }, { context });
      expect(read).toMatchObject(
        platform === "native"
          ? { status: "ok" }
          : { status: "error", error: { kind: "not_found" } },
      );
    }
  });
});
