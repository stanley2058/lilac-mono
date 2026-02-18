import { describe, expect, it } from "bun:test";

import { localApplyPatchTool } from "../../src/tools/apply-patch/local-apply-patch-tool";

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

async function resolveExecuteResult<T>(value: T | PromiseLike<T> | AsyncIterable<T>): Promise<T> {
  if (isAsyncIterable(value)) {
    let last: T | undefined;
    for await (const chunk of value) {
      last = chunk;
    }
    if (last === undefined) {
      throw new Error("AsyncIterable tool execute produced no values");
    }
    return last;
  }

  return await value;
}

describe("apply_patch remote denylist", () => {
  it("rejects patching ~/.ssh when remote cwd is ~", async () => {
    const tools = localApplyPatchTool(process.cwd());
    const applyPatch = tools.apply_patch;

    const patchText = [
      "*** Begin Patch",
      "*** Add File: .ssh/config",
      "+Host example",
      "*** End Patch",
    ].join("\n");

    const res = await resolveExecuteResult(
      applyPatch.execute!(
        { patchText, cwd: "myhost:~" },
        {
          toolCallId: "ap-remote-deny-1",
          messages: [],
          abortSignal: undefined,
          experimental_context: undefined,
        },
      ),
    );

    expect(res.status).toBe("failed");
    expect(res.output ?? "").toContain("Access denied");
  });

  it("bypasses remote denylist precheck when dangerouslyAllow=true", async () => {
    const tools = localApplyPatchTool(process.cwd());
    const applyPatch = tools.apply_patch;

    const patchText = [
      "*** Begin Patch",
      "*** Add File: .ssh/config",
      "+Host example",
      "*** End Patch",
    ].join("\n");

    const res = await resolveExecuteResult(
      applyPatch.execute!(
        { patchText, cwd: "myhost:~", dangerouslyAllow: true },
        {
          toolCallId: "ap-remote-allow-1",
          messages: [],
          abortSignal: undefined,
          experimental_context: undefined,
        },
      ),
    );

    expect(res.status).toBe("failed");
    expect(res.output ?? "").not.toContain("Access denied");
  });
});
