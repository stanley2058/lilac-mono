import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { decodeSshProbeOutput } from "../src/tool-server/tools/ssh";
import {
  decodeGithubReleaseResponse,
  GithubReleaseResponseInvalid,
} from "../src/tool-server/tools/onboarding";
import {
  decodeFirecrawlSearchResponse,
  FirecrawlSearchResponseInvalid,
} from "../src/tool-server/tools/web-search/firecrawl-web-search-provider";
import {
  decodeFirecrawlScrapeResponse,
  FirecrawlScrapeResponseInvalid,
} from "../src/tool-server/tools/web";
import {
  decodeToolInput,
  ToolInputValidationError,
} from "../src/tool-server/validation-error-message";
import { BridgeFnResponse } from "../src/tool-server/schema";
import { normalizeSuccessfulToolValue } from "../src/tool-server/create-tool-server";

describe("tool-server boundaries", () => {
  it("accepts only the strict typed /call response wire", () => {
    expect(BridgeFnResponse.safeParse({ status: "ok", value: { count: 1 } }).success).toBe(true);
    expect(
      BridgeFnResponse.safeParse({
        status: "error",
        error: {
          kind: "usage",
          code: "invalid_input",
          message: "Invalid input",
          retryable: false,
          details: { field: "path" },
        },
      }).success,
    ).toBe(true);

    for (const invalid of [
      { isError: false, output: { legacy: true } },
      { status: "ok", value: null, output: "extra" },
      {
        status: "error",
        error: {
          kind: "usage",
          code: "invalid_input",
          message: "Invalid input",
          retryable: false,
          extra: true,
        },
      },
      { status: "error", error: "string-only failure" },
    ]) {
      expect(BridgeFnResponse.safeParse(invalid).success).toBe(false);
    }
  });

  it("normalizes successful tool values with HTTP JSON semantics", () => {
    const normalized = normalizeSuccessfulToolValue({
      ok: true,
      optional: undefined,
      items: [undefined, { optional: undefined }],
      date: new Date("2026-08-17T12:00:00.000Z"),
      custom: {
        toJSON() {
          return { projected: true, optional: undefined };
        },
      },
    });

    expect(normalized.status).toBe("ok");
    if (normalized.status === "error") throw normalized.error;
    expect(normalized.value).toEqual({
      ok: true,
      items: [null, {}],
      date: "2026-08-17T12:00:00.000Z",
      custom: { projected: true },
    });
  });

  it("rejects values that cannot enter the successful tool wire", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const secret = "tool-output-projection-secret";
    const invalid = [
      undefined,
      cyclic,
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      {
        toJSON() {
          throw new Error(secret);
        },
      },
    ];

    for (const value of invalid) {
      const normalized = normalizeSuccessfulToolValue(value);
      expect(normalized.status).toBe("error");
      if (normalized.status === "ok") throw new Error("expected invalid tool output");
      expect(normalized.error.message).toBe("Plugin tool output violated the JSON wire contract");
      expect(normalized.error.message).not.toContain(secret);
    }
  });

  it("returns a typed validation failure without retaining the raw tool payload", () => {
    const secret = "tool-input-secret";
    const decoded = decodeToolInput({
      callableId: "example.call",
      input: { expected: 1, secret },
      schema: z.object({ expected: z.string() }),
    });

    expect(decoded.status).toBe("error");
    if (decoded.status === "ok") throw new Error("expected invalid tool input");
    expect(decoded.error).toBeInstanceOf(ToolInputValidationError);
    expect(decoded.error.message).toContain("Provided keys: expected, secret");
    expect(Object.hasOwn(decoded.error, "input")).toBe(false);
    expect(decoded.error.message).not.toContain(secret);
    expect(JSON.stringify(decoded.error)).not.toContain(secret);
  });

  it("fully decodes Firecrawl search responses and strips unused provider fields", () => {
    const decoded = decodeFirecrawlSearchResponse({
      success: true,
      data: [{ url: "https://example.com", title: "Example", providerSecret: "hidden" }],
      providerSecret: "hidden",
    });

    expect(decoded.status).toBe("ok");
    if (decoded.status === "error") throw decoded.error;
    expect(decoded.value).toEqual({
      success: true,
      data: [{ url: "https://example.com", title: "Example" }],
    });

    const invalid = decodeFirecrawlSearchResponse({ data: { web: "not-an-array" } });
    expect(invalid.status).toBe("error");
    if (invalid.status === "error")
      expect(invalid.error).toBeInstanceOf(FirecrawlSearchResponseInvalid);
  });

  it("fully decodes Firecrawl scrape and GitHub release responses", () => {
    const scrape = decodeFirecrawlScrapeResponse({
      success: true,
      data: {
        url: "https://example.com",
        markdown: "body",
        metadata: { title: "Example", providerSecret: "hidden" },
      },
      providerSecret: "hidden",
    });
    expect(scrape.status).toBe("ok");
    if (scrape.status === "error") throw scrape.error;
    expect(scrape.value).toEqual({
      success: true,
      data: {
        url: "https://example.com",
        markdown: "body",
        metadata: { title: "Example" },
      },
    });
    const invalidScrape = decodeFirecrawlScrapeResponse({ data: { markdown: 42 } });
    expect(invalidScrape.status).toBe("error");
    if (invalidScrape.status === "error") {
      expect(invalidScrape.error).toBeInstanceOf(FirecrawlScrapeResponseInvalid);
    }

    const release = decodeGithubReleaseResponse({
      tag_name: "v1.2.3",
      assets: [{ name: "tool.tar.gz", browser_download_url: "https://example.com/tool" }],
      providerSecret: "hidden",
    });
    expect(release.status).toBe("ok");
    if (release.status === "error") throw release.error;
    expect(release.value).toEqual({
      tag_name: "v1.2.3",
      assets: [{ name: "tool.tar.gz", browser_download_url: "https://example.com/tool" }],
    });
    const invalidRelease = decodeGithubReleaseResponse({ tag_name: "v1.2.3", assets: [{}] });
    expect(invalidRelease.status).toBe("error");
    if (invalidRelease.status === "error") {
      expect(invalidRelease.error).toBeInstanceOf(GithubReleaseResponseInvalid);
    }
  });

  it("rejects malformed SSH probe output instead of forwarding opaque remote JSON", () => {
    const decoded = decodeSshProbeOutput(JSON.stringify({ ok: true, injected: "payload" }));
    expect(decoded.status).toBe("error");
    if (decoded.status === "error") {
      expect(decoded.error.message).toBe("SSH probe returned an invalid response contract");
    }
  });
});
