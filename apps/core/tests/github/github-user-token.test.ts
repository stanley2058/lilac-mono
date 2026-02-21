import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getGithubEnvForBash } from "../../src/github/github-auth";
import {
  clearGithubUserTokenSecret,
  readGithubUserTokenSecret,
  resolveGithubUserTokenSecretPath,
  writeGithubUserTokenSecret,
} from "../../src/github/github-user-token";

describe("github user token secret", () => {
  let dataDir = "";

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "lilac-gh-user-token-"));
  });

  afterEach(async () => {
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
});
