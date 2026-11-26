import { describe, expect, it } from "bun:test";

import { githubMessageUrl, githubReplyPrefix, githubWebBaseUrl } from "../../src/github/github-ids";

describe("githubWebBaseUrl", () => {
  it("defaults to github.com", () => {
    expect(githubWebBaseUrl({})).toBe("https://github.com");
    expect(githubWebBaseUrl({ host: "github.com" })).toBe("https://github.com");
    expect(githubWebBaseUrl({ apiBaseUrl: "https://api.github.com" })).toBe("https://github.com");
  });

  it("uses the configured GHES host", () => {
    expect(githubWebBaseUrl({ host: "github.example.com" })).toBe("https://github.example.com");
    expect(githubWebBaseUrl({ host: "https://github.example.com/" })).toBe(
      "https://github.example.com",
    );
  });

  it("derives the web host from the API base URL when no host is configured", () => {
    expect(githubWebBaseUrl({ apiBaseUrl: "https://github.example.com/api/v3" })).toBe(
      "https://github.example.com",
    );
    expect(githubWebBaseUrl({ apiBaseUrl: "https://api.octo.ghe.com/" })).toBe(
      "https://octo.ghe.com",
    );
  });

  it("prefers the configured host over the API base URL", () => {
    expect(
      githubWebBaseUrl({ host: "github.example.com", apiBaseUrl: "https://api.github.com" }),
    ).toBe("https://github.example.com");
  });
});

describe("githubMessageUrl", () => {
  it("builds links on the configured web host", () => {
    expect(
      githubMessageUrl({
        sessionId: "octo/repo#47",
        messageId: "1",
        webBaseUrl: "https://github.example.com/",
      }),
    ).toBe("https://github.example.com/octo/repo/issues/47#issuecomment-1");
  });
});

describe("githubReplyPrefix", () => {
  it("keeps the bare message id when the session is not a GitHub thread", () => {
    expect(githubReplyPrefix({ sessionId: "channel-1", messageId: "42" })).toBe(
      "In reply to 42:\n\n",
    );
  });
});
