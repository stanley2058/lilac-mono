import { describe, expect, it } from "bun:test";
import path from "node:path";

import { validateWorkflowSource } from "../../src/workflow/workflow-definition";

const SKILL_DIRECTORY = path.resolve(
  import.meta.dir,
  "../../../../packages/utils/builtin-skills/workflow-authoring",
);
const SKILL_PATH = path.join(SKILL_DIRECTORY, "SKILL.md");

describe("workflow authoring skill", () => {
  it("keeps the module contract example valid against the runtime validator", async () => {
    const markdown = await Bun.file(SKILL_PATH).text();
    const match = /## Module Contract[\s\S]*?```js\n([\s\S]*?)\n```/u.exec(markdown);
    expect(match?.[1]).toBeDefined();

    const validated = validateWorkflowSource({
      name: "audit-routes",
      source: match?.[1] ?? "",
    });
    expect(validated.resources).toEqual({
      agents: { maxConcurrent: 8, maxTotal: 40 },
      waits: [],
      maxNestingDepth: 8,
      operationIdleTimeoutMs: 600_000,
    });
    expect(validated.limits.maxInputBytes).toBe(262_144);
    expect(markdown).not.toContain("include-sensitive-result");
    expect(markdown).not.toContain("parallel(promises, options?)");
    expect(markdown).not.toContain("parallel(drafts.map");
  });

  it("keeps the common path lean and points branch-specific details to references", async () => {
    const markdown = await Bun.file(SKILL_PATH).text();
    expect(markdown).toContain("Fix and save again until validation reports no errors");
    expect(markdown).toContain("[REFERENCE.md](REFERENCE.md");
    expect(markdown).toContain("[RUNTIME.md](RUNTIME.md)");
    expect(markdown).not.toContain(
      "Ordinary JavaScript conditionals, loops, arrays, and object manipulation are allowed",
    );
    expect(await Bun.file(path.join(SKILL_DIRECTORY, "REFERENCE.md")).exists()).toBe(true);
    expect(await Bun.file(path.join(SKILL_DIRECTORY, "RUNTIME.md")).exists()).toBe(true);
  });
});
