import { expect, test } from "bun:test";
import { Result } from "better-result";
import { decodeConfig, failure, type RunnerRecord } from "../src/contracts";
import { DockerCli } from "../src/docker";
import { decodeRunnerTemplate, loadRunnerTemplate } from "../src/runner-template";

function template(source: string) {
  return decodeRunnerTemplate(source).unwrap();
}

test("optional template preserves defaults and unreadable files fail", async () => {
  expect((await loadRunnerTemplate()).unwrap()).toEqual({ environment: {}, mounts: [] });
  expect((await loadRunnerTemplate(`/nonexistent/${crypto.randomUUID()}`)).isErr()).toBe(true);
  expect(
    decodeConfig({ MCP_BEARER_SECRET: "test", RUNNER_TEMPLATE_PATH: "/template.yaml" }).unwrap()
      .runnerTemplatePath,
  ).toBe("/template.yaml");
});

test("example is valid and environment values remain literal strings", async () => {
  const example = await Bun.file(
    new URL("../runner-template.example.yaml", import.meta.url),
  ).text();
  expect(template(example).mounts[0]?.source).toBe("lilac-nfs-shared");
  expect(template('environment:\n  CUSTOM: "${LITERAL} with spaces"').environment.CUSTOM).toBe(
    "${LITERAL} with spaces",
  );
});

test("rejects malformed or unsupported fields and ambiguous Docker arguments", () => {
  for (const source of [
    "[",
    "null",
    "privileged: true",
    "environment:\n  VNC_PW: override",
    "environment:\n  FLAG: true",
    "environment:\n  BAD=KEY: value",
    "mounts:\n  - {type: bind, source: relative, target: /shared}",
    "mounts:\n  - {type: bind, source: '/tmp,readonly', target: /shared}",
    "mounts:\n  - {type: volume, source: shared, target: /shared}\n  - {type: volume, source: other, target: /shared}",
  ])
    expect(decodeRunnerTemplate(source).isErr()).toBe(true);
});

const config = decodeConfig({ MCP_BEARER_SECRET: "test" }).unwrap();
const record: RunnerRecord = {
  session: "a".repeat(64),
  generation: crypto.randomUUID(),
  containerId: null,
  runtimeId: null,
  port: 17000,
  state: "provisioning",
  password: "testpass",
  idleSeconds: 3600,
  expiresAt: Date.now() + 3600000,
};

test("runner creation uses existing volumes, custom image and literal environment", async () => {
  const calls: string[][] = [];
  const docker = new DockerCli(
    config,
    async (args) => {
      calls.push(args);
      return Result.ok(args[0] === "create" ? "a".repeat(64) : "[]");
    },
    template(`image: custom:tag
environment:
  CUSTOM: 'hello $(world)'
mounts:
  - {type: volume, source: shared, target: /shared}
  - {type: bind, source: /host/files, target: /files, read_only: true}
`),
  );
  expect((await docker.create(record)).isOk()).toBe(true);
  expect(calls[0]).toEqual(["volume", "inspect", "shared"]);
  expect(calls[1]).toContain("CUSTOM=hello $(world)");
  expect(calls[1]).toContain("type=volume,source=shared,target=/shared");
  expect(calls[1]).toContain("type=bind,source=/host/files,target=/files,readonly");
  expect(calls[1]?.at(-1)).toBe("custom:tag");
  expect(calls[1]).toContain("VNC_PW");
});

test("missing volume prevents container creation", async () => {
  const calls: string[][] = [];
  const docker = new DockerCli(
    config,
    async (args) => {
      calls.push(args);
      return Result.err(failure("unavailable", "missing"));
    },
    template("mounts:\n  - {type: volume, source: missing, target: /shared}"),
  );
  expect((await docker.create(record)).isErr()).toBe(true);
  expect(calls).toEqual([["volume", "inspect", "missing"]]);
});
