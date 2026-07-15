import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getGithubEnvForBash, getGithubViewerLoginOrThrow } from "../../src/github/github-auth";
import { getPreferredGithubAuthoritativeActorOrNull } from "../../src/github/github-api";
import {
  clearGithubUserTokenSecret,
  readGithubUserTokenSecret,
  resolveGithubUserTokenSecretPath,
  writeGithubUserTokenSecret,
} from "../../src/github/github-user-token";

type MockFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

function installMockFetch(handler: MockFetch): void {
  globalThis.fetch = Object.assign(handler, { preconnect: globalThis.fetch.preconnect });
}

describe("github user token secret", () => {
  let dataDir = "";
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "lilac-gh-user-token-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (!dataDir) return;
    await rm(dataDir, { recursive: true, force: true });
  });

  it("writes, reads, and clears token secret", async () => {
    const wrote = await writeGithubUserTokenSecret({
      dataDir,
      token: "  github_pat_exampletoken1234567890  ",
      host: "github.com",
      apiBaseUrl: "https://api.github.com",
      login: "octocat",
    });

    expect(wrote.jsonPath).toBe(resolveGithubUserTokenSecretPath(dataDir));
    expect(wrote.overwritten).toBe(false);

    const secret = await readGithubUserTokenSecret(dataDir);
    expect(secret).not.toBeNull();
    expect(secret?.type).toBe("github_user_token");
    expect(secret?.token).toBe("github_pat_exampletoken1234567890");
    expect(secret?.host).toBe("github.com");
    expect(secret?.apiBaseUrl).toBe("https://api.github.com");
    expect(secret?.login).toBe("octocat");

    await clearGithubUserTokenSecret(dataDir);
    const after = await readGithubUserTokenSecret(dataDir);
    expect(after).toBeNull();
  });

  it("prefers user token for canonical bash GitHub env", async () => {
    await writeGithubUserTokenSecret({
      dataDir,
      token: "github_pat_exampletoken1234567890",
      host: "github.com",
      apiBaseUrl: "https://api.github.com",
      login: "octocat",
    });

    const vars = await getGithubEnvForBash({ dataDir });

    expect(vars.GH_TOKEN).toBe("github_pat_exampletoken1234567890");
    expect(vars.GITHUB_TOKEN).toBe("github_pat_exampletoken1234567890");
    expect(vars.LILAC_GITHUB_USER_TOKEN).toBe("github_pat_exampletoken1234567890");
    expect(vars.GH_HOST).toBe("github.com");
    expect(vars.LILAC_GITHUB_USER_HOST).toBe("github.com");
  });

  it("does not throw when user token secret is malformed", async () => {
    await mkdir(path.join(dataDir, "secret"), { recursive: true });
    await writeFile(
      resolveGithubUserTokenSecretPath(dataDir),
      JSON.stringify({ type: "github_user_token", token: "abc", host: "" }),
      "utf8",
    );

    await expect(getGithubEnvForBash({ dataDir })).resolves.toEqual({});
  });

  it("rejects empty host when writing", async () => {
    await expect(
      writeGithubUserTokenSecret({
        dataDir,
        token: "github_pat_exampletoken1234567890",
        host: "",
      }),
    ).rejects.toThrow();
  });

  it("does not cache failed or non-2xx authenticated user lookups", async () => {
    for (const failure of ["network", "non-2xx", "invalid-response"] as const) {
      let calls = 0;
      const token = `github_pat_retry_${failure}_${crypto.randomUUID()}`;
      installMockFetch(async () => {
        calls += 1;
        if (calls === 1) {
          if (failure === "network") throw new Error("temporary network failure");
          if (failure === "non-2xx") {
            return new Response("temporarily unavailable", { status: 503 });
          }
          return Response.json({ login: "" });
        }
        return Response.json({ login: "Recovered-Owner" });
      });

      await expect(
        getGithubViewerLoginOrThrow({ apiBaseUrl: "https://api.github.test", token }),
      ).rejects.toThrow();
      await expect(
        getGithubViewerLoginOrThrow({ apiBaseUrl: "https://api.github.test", token }),
      ).resolves.toBe("Recovered-Owner");
      expect(calls).toBe(2);
    }
  });

  it("propagates configured PAT identity lookup failures and later recovers", async () => {
    await writeGithubUserTokenSecret({
      dataDir,
      token: `github_pat_authority_${crypto.randomUUID()}`,
      apiBaseUrl: "https://api.github.test",
    });
    let calls = 0;
    installMockFetch(async () => {
      calls += 1;
      if (calls === 1) return new Response("bad gateway", { status: 502 });
      return Response.json({ login: "Canonical-Owner" });
    });

    await expect(getPreferredGithubAuthoritativeActorOrNull({ dataDir })).rejects.toThrow(
      "GitHub API error (502",
    );
    await expect(getPreferredGithubAuthoritativeActorOrNull({ dataDir })).resolves.toEqual({
      source: "user",
      login: "canonical-owner",
    });
    expect(calls).toBe(2);
  });
});
