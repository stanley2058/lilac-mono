import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ContentInspect,
  contentInspectInputSchema,
  isTextLikeMediaType,
  loadInspectSource,
  resolveInspectMediaType,
} from "../../src/tool-server/tools/content-inspect";

type MockFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

let restoreFetch: (() => void) | undefined;

function installMockFetch(handler: MockFetch): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
    restoreFetch = undefined;
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "content-inspect-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  restoreFetch?.();
});

describe("content.inspect", () => {
  it("advertises bare positional text input", async () => {
    const [entry] = await new ContentInspect().list();

    expect(entry?.primaryPositional).toEqual({ field: "text" });
  });

  it("recognizes text-like media types", () => {
    expect(isTextLikeMediaType("text/plain; charset=utf-8")).toBe(true);
    expect(isTextLikeMediaType("application/json")).toBe(true);
    expect(isTextLikeMediaType("image/svg+xml")).toBe(true);
    expect(isTextLikeMediaType("image/png")).toBe(false);
  });

  it("resolves text media types from declared content type, extension, and UTF-8 bytes", () => {
    expect(resolveInspectMediaType({ declared: "text/html; charset=utf-8" })).toBe("text/html");
    expect(resolveInspectMediaType({ source: "/tmp/content-inspect-smoke.txt" })).toBe(
      "text/plain",
    );
    expect(resolveInspectMediaType({ bytes: new TextEncoder().encode("hello\n") })).toBe(
      "text/plain",
    );
  });

  it("loads a .txt path as text instead of application/octet-stream", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "content-inspect-smoke.txt");
      await fs.writeFile(filePath, "smoke text\n", "utf8");

      const input = contentInspectInputSchema.parse({ path: filePath });
      if (input.type !== "binary") throw new Error("expected binary input");

      const source = await loadInspectSource(input);

      expect(source.kind).toBe("text");
      expect(source.mediaType).toBe("text/plain");
      if (source.kind === "text") {
        expect(source.text).toBe("smoke text\n");
      }
    });
  });

  it("loads text URLs using the response content type", async () => {
    installMockFetch(async () => {
      return new Response("<html>hello</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    const input = contentInspectInputSchema.parse({ url: "https://example.com" });
    if (input.type !== "binary") throw new Error("expected binary input");

    const source = await loadInspectSource(input);

    expect(source.kind).toBe("text");
    expect(source.mediaType).toBe("text/html");
    if (source.kind === "text") {
      expect(source.text).toBe("<html>hello</html>");
    }
  });

  it("decodes text URLs using the declared charset", async () => {
    installMockFetch(async () => {
      return new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
        headers: { "content-type": "text/plain; charset=windows-1252" },
      });
    });

    const input = contentInspectInputSchema.parse({ url: "https://example.com/latin1.txt" });
    if (input.type !== "binary") throw new Error("expected binary input");

    const source = await loadInspectSource(input);

    expect(source.kind).toBe("text");
    expect(source.mediaType).toBe("text/plain");
    if (source.kind === "text") {
      expect(source.charset).toBe("windows-1252");
      expect(source.text).toBe("café");
    }
  });
});
