import { describe, expect, it } from "bun:test";
import path from "node:path";

import { matchesGlobWithDotfiles } from "../src/glob-match";

const cases = [
  [".env", "**/*", true],
  [".env", "*", true],
  [".hidden/config.ts", "**/*.ts", true],
  ["src/.cache/x", "src/**", true],
  ["a/.env", "**/.*", true],
  [".github/ci.yml", ".github/**", true],
  ["src/a.ts", "**/*", true],
  ["src/a.ts", "*.ts", false],
  [".env", "*.ts", false],
] as const;

describe("matchesGlobWithDotfiles", () => {
  it("matches dot-prefixed segments under Bun", () => {
    expect(cases.map(([file, pattern]) => matchesGlobWithDotfiles(file, pattern))).toEqual(
      cases.map(([, , expected]) => expected),
    );
  });

  it("gives Node the same answers as Bun", async () => {
    const modulePath = path.join(import.meta.dir, "../src/glob-match.ts");
    const script = `const { matchesGlobWithDotfiles } = await import(${JSON.stringify(modulePath)});
const cases = ${JSON.stringify(cases)};
process.stdout.write(JSON.stringify(cases.map(([file, pattern]) => matchesGlobWithDotfiles(file, pattern))));`;
    const child = Bun.spawn(
      ["node", "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual(cases.map(([, , expected]) => expected));
  });
});
