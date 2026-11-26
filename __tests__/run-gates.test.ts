import { describe, expect, test } from "bun:test";
import {
  buildGates,
  discoverWorkspaces,
  gateSettings,
  parseOptions,
  workspaceInputs,
} from "../scripts/run-gates";

const workspaces = await discoverWorkspaces();
const inputs = await workspaceInputs(workspaces);

describe("check gates", () => {
  test("every workspace is typechecked and tested", () => {
    const ids = new Set(buildGates(workspaces, { mode: "check" }).map((gate) => gate.id));
    for (const { dir } of workspaces) {
      expect(ids).toContain(`typecheck ${dir}`);
      expect(ids).toContain(`test ${dir}`);
    }
  });

  test("a CI shard applies only to the Core tests", () => {
    const sharded = buildGates(workspaces, { mode: "ci", shard: "2/3" }).filter((gate) =>
      gate.command.includes("--shard=2/3"),
    );
    expect(sharded.map((gate) => gate.id)).toEqual(["test apps/core"]);
    expect(sharded[0]?.group).toBe("core");
  });

  test("CI never reuses results", () => {
    expect(parseOptions(["ci", "--group=static"])).toMatchObject({ group: "static", reuse: false });
    expect(parseOptions(["check"]).reuse).toBe(true);
    expect(parseOptions(["check", "--no-reuse"]).reuse).toBe(false);
    expect(() => parseOptions(["check", "--group=web"])).toThrow("Unknown gate group");
  });

  test("worker counts fit the machine", () => {
    expect(gateSettings("check", 32)).toEqual({
      pool: 6,
      coreTestWorkers: 16,
      architectureWorkers: 4,
    });
    expect(gateSettings("ci", 4)).toEqual({ pool: 2, coreTestWorkers: 4, architectureWorkers: 1 });
  });
});

describe("reused results", () => {
  test("follow declared workspace dependencies transitively", () => {
    expect([...inputs.get("packages/coding-tools")!]).toEqual(
      expect.arrayContaining(["packages/agent", "packages/fs", "packages/utils"]),
    );
  });

  test("follow relative imports and fixtures read from another workspace", () => {
    // Core tests import packages/client by relative path and read the runner's seccomp profile.
    expect([...inputs.get("apps/core")!]).toEqual(
      expect.arrayContaining(["packages/client", "packages/computer-use-runner"]),
    );
    // A utils test imports `../../agent/...`, which names no workspace root.
    expect(inputs.get("packages/utils")).toContain("packages/agent");
  });

  test("ignore workspace paths named in comments and test strings", () => {
    // client-protocol and utils tests use Core paths as data; tui mentions none.
    expect(inputs.get("packages/client-protocol")).not.toContain("apps/core");
    expect(inputs.get("packages/utils")).not.toContain("apps/core");
    expect(inputs.get("apps/tui")).not.toContain("apps/core");
  });

  test("ignore paths into ignored build output", () => {
    // Core serves `apps/web/dist`, which is built output rather than a gate input.
    expect(inputs.get("apps/core")).not.toContain("apps/web");
  });
});
