import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("release gate blocks a SHA without successful push CI", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/release.yaml").text()) as {
    jobs: { "release-info": { steps: { name: string; run?: string }[] } };
  };
  const gate = workflow.jobs["release-info"].steps.find(
    (step) => step.name === "Require successful CI for this exact commit",
  );
  expect(gate?.run).toBeDefined();
  const root = await mkdtemp(path.join(tmpdir(), "release-gate-"));
  try {
    await writeFile(
      path.join(root, "gh"),
      '#!/bin/sh\nprintf "%s\\n" "$*" > "$GATE_ARGUMENTS"\nprintf "%s\\n" "$GATE_COUNT"\n',
      { mode: 0o755 },
    );
    for (const count of ["0", "1"]) {
      const child = Bun.spawn(["bash", "-e", "-c", gate!.run!], {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          GITHUB_SHA: "exact-release-sha",
          GITHUB_REPOSITORY: "owner/repo",
          GATE_COUNT: count,
          GATE_ARGUMENTS: path.join(root, "arguments"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(await child.exited).toBe(count === "0" ? 1 : 0);
      const argumentsText = await Bun.file(path.join(root, "arguments")).text();
      expect(argumentsText).toContain("head_sha=exact-release-sha");
      expect(argumentsText).toContain("status=success");
      expect(argumentsText).toContain("event=push");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
