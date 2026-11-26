import { expect, test } from "bun:test";

import {
  nativeToolActivityDetail,
  nativeToolActivityLabel,
  nativeToolActivityResult,
} from "./native-activity-result";

function activityResult(toolName: string, result: unknown) {
  return nativeToolActivityResult({ toolName, event: { result } });
}

test("bash results expose combined output and the exit code", () => {
  expect(activityResult("bash", { stdout: "ok\n", stderr: "warn\n", exitCode: 0 })).toEqual({
    output: "ok\n\nwarn",
    exitCode: 0,
  });
  expect(
    activityResult("bash", {
      stdout: "",
      stderr: "",
      exitCode: -1,
      executionError: {
        type: "timeout",
        code: "wall_clock_timeout",
        timeoutMs: 30_000,
        timeoutKind: "wall_clock",
        signal: "SIGTERM",
      },
    }),
  ).toEqual({ output: "Timed out after 30s", exitCode: -1 });
});

test("other results become bounded, redacted text previews", () => {
  expect(activityResult("read", "x".repeat(5000)).output).toHaveLength(4000);
  expect(activityResult("tool", { content: [{ type: "text", text: "API_TOKEN=abc" }] })).toEqual({
    output: "API_TOKEN=<redacted>",
  });
  expect(activityResult("tool", { found: 2 })).toEqual({ output: '{"found":2}' });
  expect(activityResult("tool", undefined)).toEqual({});
});

test("read results show file content, errors, or the attached file", () => {
  expect(
    activityResult("read", { success: true, format: "numbered", numberedContent: "1| hi" }),
  ).toEqual({
    output: "1| hi",
  });
  expect(
    activityResult("read", {
      success: false,
      resolvedPath: "/x",
      error: { code: "x", message: "Missing" },
    }),
  ).toEqual({ output: "Missing" });
  expect(
    activityResult("read", {
      success: true,
      kind: "attachment",
      resolvedPath: "/tmp/shot.png",
      fileHash: "h",
      filename: "shot.png",
      mimeType: "image/png",
      bytes: 10,
    }),
  ).toEqual({ file: { path: "/tmp/shot.png", mediaType: "image/png" } });
});

test("redaction runs before the preview is truncated", () => {
  const token = `ghp_${"a".repeat(36)}`;
  const output = activityResult("tool", `${"x".repeat(3980)} ${token}`).output!;
  expect(output).not.toContain("ghp_aaaa");
  expect(output.length).toBeLessThanOrEqual(4000);
});

test("bash commands keep their original whitespace for the expanded view", () => {
  const command = "cat <<'EOF'\n  indented\nEOF";
  expect(nativeToolActivityDetail({ toolName: "bash", event: { args: { command } } })).toEqual({
    detail: `bash ${command}`,
  });
  expect(nativeToolActivityDetail({ toolName: "read", event: { args: { path: "a" } } })).toEqual(
    {},
  );
});

test("command details are redacted", () => {
  expect(
    nativeToolActivityDetail({
      toolName: "bash",
      event: { args: { command: "API_TOKEN=abc deploy" } },
    }),
  ).toEqual({ detail: "bash API_TOKEN=<redacted> deploy" });
});

test("edit details list every changed path", () => {
  const patchText = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "*** Add File: src/b.ts",
    "*** End Patch",
  ].join("\n");
  expect(
    nativeToolActivityDetail({ toolName: "apply_patch", event: { args: { patchText } } }),
  ).toEqual({ detail: "apply_patch src/a.ts\nsrc/b.ts" });
  expect(
    nativeToolActivityDetail({ toolName: "edit", event: { args: { path: "src/c.ts" } } }),
  ).toEqual({ detail: "edit src/c.ts" });
});

test("a bash activity label never shows a secret from the command", () => {
  const token = `ghp_${"a".repeat(36)}`;
  const label = nativeToolActivityLabel({
    toolName: "bash",
    event: { args: { command: `GH_TOKEN=${token} bun dev`, background: "service" } },
  });
  expect(label).toStartWith("bash ");
  expect(label).not.toContain("ghp_aaaa");
});
