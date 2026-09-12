import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Result } from "better-result";
import { parseDocument } from "yaml";
import { composeArguments, startDeployment } from "../src/deployment";
import { command, InstallerSystemFailed } from "../src/system";

const images = {
  core: "registry.example/lilac:release",
  gateway: "registry.example/gateway:release",
  runner: "registry.example/runner:release",
};

const compose = `name: lilac_acceptance-1
services:
  lilac:
    image: ${images.core}
    profiles: [runtime]
    depends_on: [redis]
  redis:
    image: redis:7-alpine
  computer-use-gateway:
    image: ${images.gateway}
    profiles: [desktop]
  unrelated:
    image: registry.example/unrelated:release
    profiles: [runtime, desktop]
`;

type CommandOutcome = Awaited<ReturnType<typeof command>>;
type Invocation = {
  args: string[];
  options: Exclude<Parameters<typeof command>[1], undefined>;
};

function fakeCommand(outcomes: CommandOutcome[] = []) {
  const calls: Invocation[] = [];
  const run: typeof command = async (args, options = {}) => {
    calls.push({ args: [...args], options: { ...options } });
    return outcomes[calls.length - 1] ?? Result.ok({ code: 0, stdout: "" });
  };
  return { calls, run };
}

async function withDeployment(source: string | undefined, test: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "installer-lifecycle-"));
  try {
    if (source !== undefined) await Bun.write(path.join(root, "compose.yaml"), source);
    await test(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function composePrefix(root: string) {
  return [
    "docker",
    "compose",
    "--file",
    path.resolve(root, "compose.yaml"),
    "--project-name",
    "lilac_acceptance-1",
    "--profile",
    "",
  ];
}

describe("installer deployment lifecycle targeting", () => {
  it.each([false, true])(
    "pins the installation despite ambient Compose settings with computer use %j",
    async (computerEnabled) => {
      await withDeployment(compose, async (root) => {
        const ambient = {
          COMPOSE_FILE: path.join(root, "unrelated.yaml"),
          COMPOSE_PROJECT_NAME: "unrelated-project",
          COMPOSE_PROFILES: "runtime,desktop",
        };
        const previous = Object.fromEntries(
          Object.keys(ambient).map((key) => [key, process.env[key]]),
        );
        try {
          Object.assign(process.env, ambient);
          await Bun.write(
            path.join(root, ".env"),
            "COMPOSE_FILE=unrelated.yaml\nCOMPOSE_PROJECT_NAME=dotenv-project\nCOMPOSE_PROFILES=runtime,desktop\n",
          );
          await Bun.write(
            path.join(root, "unrelated.yaml"),
            "name: unrelated\nservices:\n  unrelated:\n    image: unrelated\n",
          );
          const fake = fakeCommand();
          const result = await startDeployment(root, images, computerEnabled, fake.run);
          expect(result.isOk()).toBe(true);
          const services = computerEnabled ? ["lilac", "computer-use-gateway"] : ["lilac"];
          const expected = [
            [...composePrefix(root), "pull", "--include-deps", "--ignore-buildable", ...services],
            [
              ...composePrefix(root),
              "up",
              "--detach",
              "--wait",
              "--wait-timeout",
              "180",
              "--force-recreate",
              ...services,
            ],
          ];
          if (computerEnabled) expected.unshift(["docker", "pull", images.runner]);
          expect(fake.calls.map((call) => call.args)).toEqual(expected);
          for (const call of fake.calls.filter((entry) => entry.args[1] === "compose")) {
            expect(call.options.cwd).toBe(root);
            expect(call.options.inherit).toBe(true);
          }
        } finally {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      });
    },
  );

  it("uses an absolute Compose file when the selected installation path is relative", async () => {
    await withDeployment(compose, async (root) => {
      const fake = fakeCommand();
      const result = await startDeployment(
        path.relative(process.cwd(), root),
        images,
        false,
        fake.run,
      );
      expect(result.isOk()).toBe(true);
      expect(fake.calls[0]?.args).toEqual([
        ...composePrefix(root),
        "pull",
        "--include-deps",
        "--ignore-buildable",
        "lilac",
      ]);
    });
  });

  it("uses the deterministic installation name when Compose does not declare one", async () => {
    await withDeployment("services:\n  lilac:\n    image: lilac\n", async (root) => {
      const fake = fakeCommand();
      const result = await startDeployment(root, images, false, fake.run);
      expect(result.isOk()).toBe(true);
      const expectedName = `lilac-${createHash("sha256").update(root).digest("hex").slice(0, 10)}`;
      for (const call of fake.calls) {
        expect(call.args.slice(0, 6)).toEqual([
          "docker",
          "compose",
          "--file",
          path.join(root, "compose.yaml"),
          "--project-name",
          expectedName,
        ]);
      }
    });
  });
});

describe("installer deployment lifecycle input failures", () => {
  it.each([
    { label: "missing Compose file", source: undefined },
    { label: "malformed Compose file", source: "name: valid\nservices: [" },
    {
      label: "non-string project name",
      source: "name: 123\nservices:\n  lilac:\n    image: lilac\n",
    },
    {
      label: "interpolated project name",
      source: "name: ${PROJECT_NAME}\nservices:\n  lilac:\n    image: lilac\n",
    },
    {
      label: "uppercase project name",
      source: "name: Lilac\nservices:\n  lilac:\n    image: lilac\n",
    },
    {
      label: "leading-dash project name",
      source: "name: -lilac\nservices:\n  lilac:\n    image: lilac\n",
    },
    {
      label: "non-mapping Compose document",
      source: "[]\n",
    },
  ])("rejects $label before running Docker", async ({ source }) => {
    await withDeployment(source, async (root) => {
      const fake = fakeCommand();
      const result = await startDeployment(root, images, true, fake.run);
      expect(result.isErr()).toBe(true);
      expect(fake.calls).toEqual([]);
    });
  });

  it("returns an expected failure when compose.yaml cannot be read as a file", async () => {
    await withDeployment(undefined, async (root) => {
      await mkdir(path.join(root, "compose.yaml"));
      const fake = fakeCommand();
      const result = await startDeployment(root, images, true, fake.run);
      expect(result.isErr()).toBe(true);
      expect(fake.calls).toEqual([]);
    });
  });

  it("validates a proposed project name before a Compose file exists", async () => {
    await withDeployment(undefined, async (root) => {
      const proposed = parseDocument(
        "name: ${PROJECT_NAME}\nservices:\n  lilac:\n    image: lilac\n",
      );
      const original = proposed.toString();
      expect(composeArguments(root, proposed).isErr()).toBe(true);
      expect(proposed.toString()).toBe(original);
      expect(await Bun.file(path.join(root, "compose.yaml")).exists()).toBe(false);
    });
  });
});

describe("installer deployment lifecycle command failures", () => {
  const phases = [
    { label: "runner pull", index: 0 },
    { label: "Compose pull", index: 1 },
    { label: "Compose startup", index: 2 },
  ];

  it.each(phases)("stops after a nonzero $label exit", async ({ index }) => {
    await withDeployment(compose, async (root) => {
      const outcomes: CommandOutcome[] = Array.from({ length: index + 1 }, (_, position) =>
        Result.ok({ code: position === index ? 1 : 0, stdout: "" }),
      );
      const fake = fakeCommand(outcomes);
      const result = await startDeployment(root, images, true, fake.run);
      expect(result.isErr()).toBe(true);
      expect(fake.calls).toHaveLength(index + 1);
      expect(fake.calls[0]?.args).toEqual(["docker", "pull", images.runner]);
    });
  });

  it.each(phases)("propagates a $label command failure without continuing", async ({ index }) => {
    await withDeployment(compose, async (root) => {
      const failure = new InstallerSystemFailed({ message: "Fixture command could not start." });
      const outcomes: CommandOutcome[] = Array.from({ length: index }, () =>
        Result.ok({ code: 0, stdout: "" }),
      );
      outcomes.push(Result.err(failure));
      const fake = fakeCommand(outcomes);
      const result = await startDeployment(root, images, true, fake.run);
      expect(result).toEqual(Result.err(failure));
      expect(fake.calls).toHaveLength(index + 1);
    });
  });
});
