import { describe, expect, it } from "bun:test";

import {
  abbreviateSshHostForDisplay,
  formatRemoteDisplayPath,
  normalizeRemoteCwd,
  parseSshCwdTarget,
} from "../../src/ssh/ssh-cwd";

describe("ssh cwd parsing", () => {
  it("treats local paths with ':' as local when host contains '/'", () => {
    const out = parseSshCwdTarget("/tmp/foo:bar");
    expect(out.kind).toBe("local");
  });

  it("parses ssh cwd and anchors relative to ~", () => {
    const out = parseSshCwdTarget("myhost:repo");
    expect(out.kind).toBe("ssh");
    if (out.kind !== "ssh") return;
    expect(out.host).toBe("myhost");
    expect(out.cwd).toBe("~/repo");
  });

  it("normalizes and clamps relative remote cwd", () => {
    expect(normalizeRemoteCwd("..")).toBe("~");
    expect(normalizeRemoteCwd("a/../b")).toBe("~/b");
    expect(normalizeRemoteCwd("./a/./b")).toBe("~/a/b");
  });

  it("normalizes tilde remote cwd", () => {
    expect(normalizeRemoteCwd("~/a/../b")).toBe("~/b");
    expect(normalizeRemoteCwd("~/")).toBe("~");
  });

  it("normalizes absolute remote cwd", () => {
    expect(normalizeRemoteCwd("/a/../b")).toBe("/b");
  });

  it("abbreviates remote hosts to display initials", () => {
    expect(abbreviateSshHostForDisplay("stanley-desktop")).toBe("SD");
    expect(abbreviateSshHostForDisplay("stanley-server")).toBe("SS");
    expect(abbreviateSshHostForDisplay("user@stanley-server")).toBe("SS");
  });

  it("formats remote display path as @XX:<path>", () => {
    expect(formatRemoteDisplayPath("stanley-server", "/repo/apps/core")).toBe(
      "@SS:/repo/apps/core",
    );
    expect(formatRemoteDisplayPath("stanley-desktop", "repo")).toBe("@SD:~/repo");
  });
});
