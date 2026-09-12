import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";

import { decodeGithubAppSecret } from "../../core/src/github/github-app";
import { decodeGithubUserTokenSecret } from "../../core/src/github/github-user-token";
import { parseMcpConfigYaml } from "../../core/src/mcp/config";
import {
  deleteConfigValue,
  getConfigValue,
  setConfigValue,
  validateConfigDocument,
} from "../src/config-document";
import { configureOptional } from "../src/optional";
import type { Prompt, SetupDraft } from "../src/types";

type Answer = { message: string; value: string | boolean };

function fakePrompt(answers: Answer[]) {
  const pending = [...answers];
  const notes: string[] = [];
  const initials: Record<string, string | boolean | undefined> = {};
  function answer(message: string): string | boolean {
    const next = pending.shift();
    expect(next?.message).toBe(message);
    if (!next) throw new Error(`Unexpected prompt: ${message}`);
    return next.value;
  }
  const prompt: Prompt = {
    async text({ message, initial }) {
      initials[message] = initial;
      return String(answer(message));
    },
    async select<T extends string>(
      message: string,
      choices: readonly { value: T; label: string }[],
      initial?: T,
    ): Promise<T> {
      initials[message] = initial;
      const value = answer(message);
      const chosen = choices.find((choice) => choice.value === value);
      if (!chosen) throw new Error(`Unknown test choice ${value} for ${message}`);
      return chosen.value;
    },
    async confirm(message, initial) {
      initials[message] = initial;
      return Boolean(answer(message));
    },
    note(message) {
      notes.push(message);
    },
  };
  return { prompt, notes, initials, assertComplete: () => expect(pending).toEqual([]) };
}

function fixture(source = "configVersion: 2\n", files: Record<string, string> = {}) {
  const document = parseDocument(source);
  const draft: SetupDraft = {
    get: (path) => getConfigValue(document, path),
    set: (path, value) => setConfigValue(document, path, value),
    remove: (path) => deleteConfigValue(document, path),
    secrets: {},
    configuredEnvironmentKeys: new Set(),
    files: [],
    stagingDir: "unused",
    async readExistingFile(relativePath) {
      return files[relativePath];
    },
    computerEnabled: false,
  };
  return { draft, document };
}

const finish: Answer = { message: "Optional setup", value: "done" };

describe("optional installer setup", () => {
  it("leaves config, credentials, and files untouched when skipped", async () => {
    const source =
      "# Preserve this comment\nconfigVersion: 2\ntools:\n  web:\n    fetch:\n      mode: auto\nentity:\n  users:\n    Existing:\n      discord: '123456789012345678'\n";
    const { draft, document } = fixture(source, { "mcp-config.yaml": "untouched" });
    draft.secrets.EXA_API_KEY = "saved-test-key";
    draft.computerEnabled = true;
    const ui = fakePrompt([finish]);
    await configureOptional(ui.prompt, draft);
    expect(document.toString()).toBe(source);
    expect(draft.secrets).toEqual({ EXA_API_KEY: "saved-test-key" });
    expect(draft.files).toEqual([]);
    expect(draft.computerEnabled).toBe(true);
    expect(draft.configuredEnvironmentKeys?.size).toBe(0);
    ui.assertComplete();
  });

  it("does not mark computer environment keys when its setup is declined", async () => {
    const { draft } = fixture();
    draft.computerEnabled = true;
    draft.secrets.MCP_BEARER_SECRET = "existing-test-secret";
    draft.secrets.BIND_ADDR = "127.0.0.1";
    const ui = fakePrompt([
      { message: "Optional setup", value: "computer" },
      { message: "Enable computer use?", value: false },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect(draft.configuredEnvironmentKeys?.size).toBe(0);
    expect(draft.files).toEqual([]);
    expect(draft.computerEnabled).toBe(true);
    ui.assertComplete();
  });

  it("marks confirmed computer values even when their values remain unchanged", async () => {
    const { draft } = fixture();
    Object.assign(draft.secrets, {
      MCP_BEARER_SECRET: "existing-test-secret",
      BIND_ADDR: "127.0.0.1",
      RENDERED_HOST: "http://localhost",
      PORT_RANGE_START: "17000",
      PORT_RANGE_END: "17031",
    });
    const ui = fakePrompt([
      { message: "Optional setup", value: "computer" },
      { message: "Enable computer use?", value: true },
      { message: "Customize the desktop address and port range?", value: true },
      { message: "Desktop port bind address", value: "127.0.0.1" },
      { message: "Desktop viewer URL host", value: "http://localhost" },
      { message: "First desktop port", value: "17000" },
      { message: "Last desktop port", value: "17031" },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect([...(draft.configuredEnvironmentKeys ?? [])].sort()).toEqual([
      "BIND_ADDR",
      "MCP_BEARER_SECRET",
      "PORT_RANGE_END",
      "PORT_RANGE_START",
      "RENDERED_HOST",
    ]);
    expect(draft.secrets.MCP_BEARER_SECRET).toBe("existing-test-secret");
    ui.assertComplete();
  });

  it("does not mark viewer keys when enabling computer use without editing the viewer", async () => {
    const { draft } = fixture();
    draft.secrets.MCP_BEARER_SECRET = "existing-test-secret";
    draft.secrets.BIND_ADDR = "127.0.0.1";
    const ui = fakePrompt([
      { message: "Optional setup", value: "computer" },
      { message: "Enable computer use?", value: true },
      { message: "Customize the desktop address and port range?", value: false },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect([...(draft.configuredEnvironmentKeys ?? [])]).toEqual(["MCP_BEARER_SECRET"]);
    ui.assertComplete();
  });

  it("marks an unchanged optional credential only after it is confirmed", async () => {
    const { draft } = fixture();
    draft.secrets.EXA_API_KEY = "existing-test-key";
    draft.secrets.FIRECRAWL_API_KEY = "other-test-key";
    const ui = fakePrompt([
      { message: "Optional setup", value: "web" },
      { message: "Web tools providers", value: "exa" },
      { message: "Exa API key", value: "existing-test-key" },
      { message: "Web tools providers", value: "done" },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect([...(draft.configuredEnvironmentKeys ?? [])]).toEqual(["EXA_API_KEY"]);
    expect(draft.secrets.EXA_API_KEY).toBe("existing-test-key");
    ui.assertComplete();
  });

  it("configures ordered web fallbacks and provider-only fetch without writing credentials into YAML", async () => {
    const { draft, document } = fixture(
      "configVersion: 2\ntools:\n  inspect:\n    model: google/existing-model\n",
    );
    const ui = fakePrompt([
      { message: "Optional setup", value: "web" },
      { message: "Web tools providers", value: "firecrawl" },
      { message: "Firecrawl API key", value: "test-firecrawl-key" },
      { message: "Web tools providers", value: "exa" },
      { message: "Exa API key", value: "test-exa-key" },
      { message: "Web tools providers", value: "tavily" },
      { message: "Tavily API key", value: "test-tavily-key" },
      { message: "Web tools providers", value: "order" },
      { message: "Provider order, comma-separated", value: "exa, exa, tavily" },
      { message: "Provider order, comma-separated", value: "exa, tavily, firecrawl" },
      { message: "Web tools providers", value: "done" },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect(draft.get(["tools", "web", "extract", "providers"])).toEqual([
      "exa",
      "tavily",
      "firecrawl",
    ]);
    expect(draft.get(["tools", "web", "fetch", "mode"])).toBe("provider-only");
    expect(draft.get(["tools", "inspect", "model"])).toBe("google/existing-model");
    expect(draft.secrets).toEqual({
      FIRECRAWL_API_KEY: "test-firecrawl-key",
      EXA_API_KEY: "test-exa-key",
      TAVILY_API_KEY: "test-tavily-key",
    });
    expect(document.toString()).not.toContain("test-exa-key");
    expect(validateConfigDocument(document).status).toBe("ok");
    expect(ui.notes.join("\n")).toContain("Include each configured provider once");
    ui.assertComplete();
  });

  it("does not change existing web behavior when returning from its menu", async () => {
    const { draft } = fixture(
      "configVersion: 2\ntools:\n  web:\n    extract:\n      providers: [exa]\n    fetch:\n      mode: auto\n",
    );
    const ui = fakePrompt([
      { message: "Optional setup", value: "web" },
      { message: "Web tools providers", value: "done" },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect(draft.get(["tools", "web", "fetch", "mode"])).toBe("auto");
  });

  it("uses local blob storage by default without expanding configuration", async () => {
    const { draft } = fixture();
    const ui = fakePrompt([
      { message: "Optional setup", value: "blobs" },
      { message: "Blob storage", value: "local" },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect(draft.get(["blobStorage"])).toBeUndefined();
    expect(ui.initials["Blob storage"]).toBe("local");
  });

  it("generates the existing S3 contract with credential environment references", async () => {
    const { draft, document } = fixture();
    const ui = fakePrompt([
      { message: "Optional setup", value: "blobs" },
      { message: "Blob storage", value: "s3" },
      { message: "S3 bucket", value: "lilac-test" },
      { message: "Object prefix", value: "installation/blobs" },
      { message: "S3 endpoint URL", value: "https://user:password@storage.example" },
      { message: "S3 endpoint URL", value: "https://storage.example" },
      { message: "S3 region", value: "us-east-1" },
      { message: "S3 access key ID", value: "test-access-id" },
      { message: "S3 secret access key", value: "test-secret-key" },
      { message: "Use a temporary S3 session token?", value: true },
      { message: "S3 session token", value: "test-session-token" },
      { message: "Use path-style bucket URLs?", value: true },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect(draft.get(["blobStorage"])).toEqual({
      kind: "s3",
      bucket: "lilac-test",
      prefix: "installation/blobs",
      endpoint: "https://storage.example",
      region: "us-east-1",
      accessKeyIdEnv: "LILAC_S3_ACCESS_KEY_ID",
      secretAccessKeyEnv: "LILAC_S3_SECRET_ACCESS_KEY",
      sessionTokenEnv: "LILAC_S3_SESSION_TOKEN",
      forcePathStyle: true,
    });
    expect(validateConfigDocument(document).status).toBe("ok");
    expect(document.toString()).not.toContain("test-secret-key");
    expect(ui.notes).toContain("Keep credentials out of the URL.");
    ui.assertComplete();
  });

  it("preserves the existing store when a backend switch is declined", async () => {
    const { draft } = fixture(
      "configVersion: 2\nblobStorage:\n  kind: local\n  root: /data/existing-blobs\n",
    );
    const ui = fakePrompt([
      { message: "Optional setup", value: "blobs" },
      { message: "Blob storage", value: "s3" },
      { message: "Switch this installation's blob storage backend?", value: false },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect(draft.get(["blobStorage"])).toEqual({ kind: "local", root: "/data/existing-blobs" });
    expect(draft.secrets).toEqual({});
  });

  it("enables thread summaries and lexical related-thread lookup without requiring embeddings", async () => {
    const { draft, document } = fixture(
      "configVersion: 2\nconversation:\n  thread:\n    summarization:\n      concurrency: 3\n    autoInject:\n      minTextUnits: 120\n",
    );
    const ui = fakePrompt([
      { message: "Optional setup", value: "threads" },
      { message: "Enable background thread summaries?", value: true },
      { message: "Thread summary model", value: "fast" },
      { message: "Enable semantic thread embeddings?", value: false },
      { message: "Automatically find related threads before replies?", value: true },
      { message: "Related-thread query planner model", value: "main" },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect(draft.get(["conversation", "thread", "autoInject", "mode"])).toBe("lexical");
    expect(draft.get(["conversation", "thread", "autoInject", "minTextUnits"])).toBe(120);
    expect(draft.get(["conversation", "thread", "summarization", "concurrency"])).toBe(3);
    expect(validateConfigDocument(document).status).toBe("ok");
    ui.assertComplete();
  });

  it("configures embedding and query-planner model fields with the existing search mode prefilled", async () => {
    const { draft } = fixture(
      "configVersion: 2\nconversation:\n  thread:\n    autoInject:\n      mode: semantic\n",
    );
    const ui = fakePrompt([
      { message: "Optional setup", value: "threads" },
      { message: "Enable background thread summaries?", value: false },
      { message: "Enable semantic thread embeddings?", value: true },
      {
        message: "Embedding model (provider/model or model alias)",
        value: "openai/text-embedding-3-small",
      },
      { message: "Automatically find related threads before replies?", value: true },
      { message: "Related-thread query planner model", value: "fast" },
      { message: "Related-thread search", value: "semantic" },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect(ui.initials["Related-thread search"]).toBe("semantic");
    expect(draft.get(["conversation", "thread", "embedding", "model"])).toBe(
      "openai/text-embedding-3-small",
    );
  });

  it("adds and updates aliases without replacing unrelated aliases", async () => {
    const { draft, document } = fixture(
      "configVersion: 2\nentity:\n  users:\n    Existing:\n      discord: '123456789012345678'\n  sessions:\n    discord:\n      general: '234567890123456789'\n",
    );
    const ui = fakePrompt([
      { message: "Optional setup", value: "entities" },
      { message: "Entity aliases", value: "user" },
      { message: "Alias name", value: "@Team Member" },
      { message: "Discord user ID", value: "nope" },
      { message: "Discord user ID", value: "345678901234567890" },
      { message: "Alias description (optional)", value: "Project owner" },
      { message: "Entity aliases", value: "channel" },
      { message: "Alias name", value: "#general" },
      { message: "Discord channel ID", value: "456789012345678901" },
      { message: "Alias description (optional)", value: "" },
      { message: "Entity aliases", value: "done" },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect(draft.get(["entity", "users", "Existing", "discord"])).toBe("123456789012345678");
    expect(draft.get(["entity", "users", "Team_Member"])).toEqual({
      discord: "345678901234567890",
      comment: "Project owner",
    });
    expect(ui.initials["Discord channel ID"]).toBe("234567890123456789");
    expect(validateConfigDocument(document).status).toBe("ok");
    ui.assertComplete();
  });

  it("stages computer-use auth and keeps other MCP servers and comments", async () => {
    const { draft } = fixture(undefined, {
      "mcp-config.yaml":
        "# Operator servers\nconfigVersion: 1\nservers:\n  existing:\n    transport: http\n    url: https://mcp.example/api # existing service\n",
    });
    const ui = fakePrompt([
      { message: "Optional setup", value: "computer" },
      { message: "Enable computer use?", value: true },
      { message: "Customize the desktop address and port range?", value: false },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect(draft.computerEnabled).toBe(true);
    const mcp = draft.files.find((file) => file.relativePath === "mcp-config.yaml")?.content ?? "";
    expect(mcp).toContain("# Operator servers");
    expect(mcp).toContain("https://mcp.example/api # existing service");
    expect(parseMcpConfigYaml(mcp).ok).toBe(true);
    expect(mcp).not.toContain(draft.secrets.MCP_BEARER_SECRET ?? "missing");
    expect(
      draft.files.find((file) => file.relativePath === "secret/computer-use-authorization"),
    ).toEqual({
      relativePath: "secret/computer-use-authorization",
      content: `Bearer ${draft.secrets.MCP_BEARER_SECRET}\n`,
      mode: 0o600,
    });
    ui.assertComplete();
  });

  it("preserves computer-use credentials across repeat configuration and validates viewer settings", async () => {
    const { draft } = fixture(undefined, {
      "secret/computer-use-authorization": "Bearer existing-test-secret\n",
    });
    const ui = fakePrompt([
      { message: "Optional setup", value: "computer" },
      { message: "Enable computer use?", value: true },
      { message: "Customize the desktop address and port range?", value: true },
      { message: "Desktop port bind address", value: "invalid" },
      { message: "Desktop port bind address", value: "127.0.0.1" },
      { message: "Desktop viewer URL host", value: "http://localhost:17000" },
      { message: "Desktop viewer URL host", value: "http://localhost" },
      { message: "First desktop port", value: "18000" },
      { message: "Last desktop port", value: "17000" },
      { message: "Last desktop port", value: "18031" },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect(draft.secrets.MCP_BEARER_SECRET).toBe("existing-test-secret");
    expect(draft.secrets.PORT_RANGE_END).toBe("18031");
    expect(ui.notes.join("\n")).not.toContain("existing-test-secret");
    ui.assertComplete();
  });

  it.each([
    "configVersion: 99\n",
    "configVersion: 1\nservers: [invalid]\n",
    "configVersion: 1\nservers: [\n",
  ])("leaves malformed MCP files untouched: %s", async (mcp) => {
    const { draft } = fixture(undefined, { "mcp-config.yaml": mcp });
    const ui = fakePrompt([
      { message: "Optional setup", value: "computer" },
      { message: "Enable computer use?", value: true },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect(draft.files).toEqual([]);
    expect(draft.computerEnabled).toBe(false);
    expect(draft.secrets).toEqual({});
  });

  it("stages both GitHub credential contracts and a container-readable App key path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lilac-installer-key-"));
    const pemPath = join(directory, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    await writeFile(pemPath, privateKey, { mode: 0o600 });
    try {
      const { draft } = fixture();
      const ui = fakePrompt([
        { message: "Optional setup", value: "github" },
        { message: "GitHub authentication", value: "both" },
        { message: "GitHub personal access token", value: "test-personal-token" },
        { message: "GitHub hostname", value: "github.com" },
        { message: "GitHub App ID", value: "invalid" },
        { message: "GitHub App ID", value: "123" },
        { message: "GitHub App installation ID", value: "456" },
        { message: "GitHub hostname", value: "github.com" },
        { message: "GitHub App private key file", value: pemPath },
        finish,
      ]);
      await configureOptional(ui.prompt, draft);
      const pat = JSON.parse(
        draft.files.find((file) => file.relativePath === "secret/github-user-token.json")
          ?.content ?? "{}",
      );
      const app = JSON.parse(
        draft.files.find((file) => file.relativePath === "secret/github-app.json")?.content ?? "{}",
      );
      expect(decodeGithubUserTokenSecret("unused", pat).status).toBe("ok");
      expect(decodeGithubAppSecret("unused", app).status).toBe("ok");
      expect(app.privateKeyPath).toBe("/data/secret/github-app.private-key.pem");
      expect(draft.files.find((file) => file.relativePath.endsWith(".pem"))?.content).toBe(
        privateKey,
      );
      expect(draft.files.every((file) => file.mode === 0o600)).toBe(true);
      expect(ui.notes.join("\n")).not.toContain("test-personal-token");
      ui.assertComplete();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prefills existing GitHub values and keeps the stored private key on updates", async () => {
    const { draft } = fixture(undefined, {
      "secret/github-user-token.json": JSON.stringify({
        type: "github_user_token",
        token: "existing-pat",
        host: "github.example",
        apiBaseUrl: "https://github.example/custom-api/v3",
      }),
      "secret/github-app.json": JSON.stringify({
        type: "github_app",
        appId: 123,
        installationId: 456,
        privateKeyPath: "/data/secret/github-app.private-key.pem",
      }),
      "secret/github-app.private-key.pem": "existing-test-key",
    });
    const ui = fakePrompt([
      { message: "Optional setup", value: "github" },
      { message: "GitHub authentication", value: "both" },
      { message: "GitHub personal access token", value: "existing-pat" },
      { message: "GitHub hostname", value: "github.example" },
      { message: "GitHub App ID", value: "123" },
      { message: "GitHub App installation ID", value: "456" },
      { message: "GitHub hostname", value: "github.com" },
      { message: "Keep the existing GitHub App private key?", value: true },
      finish,
    ]);
    await configureOptional(ui.prompt, draft);
    expect(ui.initials["GitHub personal access token"]).toBe("existing-pat");
    expect(ui.initials["GitHub App installation ID"]).toBe("456");
    expect(draft.files.find((file) => file.relativePath.endsWith(".pem"))?.content).toBe(
      "existing-test-key",
    );
    expect(
      draft.files.find((file) => file.relativePath === "secret/github-user-token.json")?.content,
    ).toContain("https://github.example/custom-api/v3");
    ui.assertComplete();
  });
});
