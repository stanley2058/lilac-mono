import { describe, expect, it } from "bun:test";

import { isWorkflowPinnedDescriptorPath } from "../../src/tool-server/tools/generate";

describe("generate.video workflow descriptor output", () => {
  it("recognizes descriptors opened by the Core process", () => {
    expect(isWorkflowPinnedDescriptorPath(`/proc/${process.pid}/fd/42`)).toBe(true);
    expect(isWorkflowPinnedDescriptorPath("/proc/self/fd/42")).toBe(true);
    expect(isWorkflowPinnedDescriptorPath(`/proc/${process.pid + 1}/fd/42`)).toBe(false);
    expect(isWorkflowPinnedDescriptorPath(`/proc/${process.pid}/fd/42/child`)).toBe(false);
  });
});
