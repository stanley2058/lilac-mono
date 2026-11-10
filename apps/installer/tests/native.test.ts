import { describe, expect, it } from "bun:test";
import { createNativeLocalAuthenticator } from "../../core/src/surface/native/auth-local";
import { configureNative } from "../src/native";
import {
  createConfigDocument,
  getConfigValue,
  setConfigValue,
  deleteConfigValue,
  validateConfigDocument,
} from "../src/config-document";
import { createDeployment } from "../src/deployment";
import type { Prompt, SetupDraft } from "../src/types";
import { existingDeploymentFixture } from "./compose-fixture";
import { parseDocument } from "yaml";

function fixture(answers: string[]) {
  const pending = [...answers];
  const document = createConfigDocument();
  const notes: string[] = [];
  const initials: Record<string, string | undefined> = {};
  const prompt: Prompt = {
    text: async () => pending.shift() ?? "",
    select: async <T extends string>(
      message: string,
      choices: readonly { value: T; label: string }[],
      initial?: T,
    ) => {
      initials[message] = initial;
      const value = pending.shift();
      const choice = choices.find((entry) => entry.value === value);
      if (!choice) throw new Error("Missing fixture answer");
      return choice.value;
    },
    confirm: async () => false,
    note: (value) => {
      notes.push(value);
    },
  };
  const draft: SetupDraft = {
    get: (key) => getConfigValue(document, key),
    set: (key, value) => setConfigValue(document, key, value),
    remove: (key) => deleteConfigValue(document, key),
    secrets: {},
    configuredEnvironmentKeys: new Set(),
    files: [],
    stagingDir: "",
    readExistingFile: async () => undefined,
    computerEnabled: false,
  };
  return { document, prompt, draft, notes, initials, pending };
}
const images = { core: "fixture/core:1", gateway: "fixture/gateway:1", runner: "fixture/runner:1" };

describe("native installer", () => {
  it("creates a native-only local owner with hashed credentials and a private published port", async () => {
    const setup = fixture(["local", "http://localhost:8789", "owner", "fixture-password"]);
    await configureNative(setup.prompt, setup.draft);
    expect(setup.initials["Native sign-in"]).toBe("local");
    expect(setup.draft.get(["surface", "native", "port"])).toBe(8789);
    expect(validateConfigDocument(setup.document).isOk()).toBe(true);
    expect(setup.draft.get(["surface", "native", "auth"])).toEqual({
      provider: "local",
      ownerId: "owner",
    });
    expect(setup.draft.secrets.DISCORD_TOKEN).toBeUndefined();
    expect(
      await Bun.password.verify(
        "fixture-password",
        setup.draft.secrets.LILAC_NATIVE_LOCAL_PASSWORD_HASH!,
      ),
    ).toBe(true);
    expect(setup.draft.secrets.LILAC_NATIVE_LOCAL_PASSWORD_HASH).toStartWith("$argon2id$");
    expect(
      Buffer.from(setup.draft.secrets.LILAC_NATIVE_SESSION_SECRET!, "base64url").byteLength,
    ).toBe(32);
    const auth = createNativeLocalAuthenticator({
      ownerUserId: "owner",
      username: setup.draft.secrets.LILAC_NATIVE_LOCAL_USERNAME!,
      passwordHash: setup.draft.secrets.LILAC_NATIVE_LOCAL_PASSWORD_HASH!,
      signingKey: new TextEncoder().encode(setup.draft.secrets.LILAC_NATIVE_SESSION_SECRET!),
      installationId: String(setup.draft.get(["surface", "native", "installationId"])),
      allowedOrigins: ["http://localhost:8789"],
    });
    const login = (
      await auth.login(
        new Request("http://localhost:8789/api/native/login", {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from("owner:fixture-password").toString("base64")}`,
          },
        }),
        "fixture",
      )
    ).unwrap();
    const principal = (
      await auth.authenticate(
        new Request("http://localhost:8789/api/native/bootstrap", {
          headers: { authorization: `Bearer ${login.token}` },
        }),
      )
    ).unwrap();
    expect(principal.userId).toBe("owner");
    expect(setup.document.toString()).not.toContain("fixture-password");
    expect(setup.notes.join("\n")).not.toContain("fixture-password");
    const deployment = createDeployment("/fixture", setup.draft, images);
    expect(deployment.getIn(["services", "lilac", "ports", 0])).toBe("127.0.0.1:8789:8789");
    expect(setup.pending).toEqual([]);
  });

  it("supports Clerk web login without terminal OAuth configuration", async () => {
    const setup = fixture([
      "clerk",
      "https://chat.example",
      "user_fixture",
      "https://clerk.example",
      "fixture-secret",
      "fixture-publishable",
    ]);
    await configureNative(setup.prompt, setup.draft);
    expect(validateConfigDocument(setup.document).isOk()).toBe(true);
    expect(setup.draft.get(["surface", "native", "auth"])).toEqual({
      provider: "clerk",
      ownerId: "owner",
      ownerProviderUserId: "user_fixture",
      clerkIssuer: "https://clerk.example",
    });
    expect(setup.draft.secrets.CLERK_SECRET_KEY).toBe("fixture-secret");
    expect(setup.document.toString()).not.toContain("fixture-secret");
    expect(setup.notes.join("\n")).not.toContain("fixture-secret");
    expect(setup.pending).toEqual([]);
  });

  it("rejects credential-bearing or nonlocal insecure public URLs", async () => {
    const setup = fixture([
      "local",
      "http://chat.example",
      "https://user:pass@chat.example",
      "https://chat.example/path",
      "http://localhost:8789",
      "owner:bad",
      "owner",
      "fixture-password",
    ]);
    await configureNative(setup.prompt, setup.draft);
    expect(setup.notes).toContain("Use HTTPS for a remote installation, or HTTP on localhost.");
    expect(setup.notes).toContain("Keep credentials out of the URL.");
    expect(setup.notes).toContain("Enter an origin without a path or trailing slash.");
    expect(setup.notes).toContain("The username cannot contain a colon.");
    expect(setup.pending).toEqual([]);
  });

  it("does not publish ports when native is disabled or change an existing deployment", async () => {
    const setup = fixture([]);
    const fresh = createDeployment("/fixture", setup.draft, images);
    expect(fresh.getIn(["services", "lilac", "ports"])).toBeUndefined();
    setup.draft.set(["surface", "native", "enabled"], true);
    const original = existingDeploymentFixture(
      parseDocument(
        "services:\n  lilac:\n    image: fixture/core:1\n    ports: ['127.0.0.1:9000:9000']\n",
      ),
    );
    const changed = createDeployment("/fixture", setup.draft, images, original);
    expect(changed.getIn(["services", "lilac", "ports", 0])).toBe("127.0.0.1:9000:9000");
    expect(changed.getIn(["services", "lilac", "ports", 1])).toBeUndefined();
  });
});

it("configures web access from the existing-install menu", async () => {
  const { configureExisting } = await import("../src/wizard");
  const setup = fixture([
    "native",
    "local",
    "http://localhost:8789",
    "owner",
    "fixture-password",
    "review",
  ]);
  await configureExisting(setup.prompt, setup.draft);
  expect(setup.draft.get(["surface", "native", "enabled"])).toBe(true);
  expect(setup.draft.secrets.LILAC_NATIVE_LOCAL_PASSWORD_HASH).toBeDefined();
  expect(setup.pending).toEqual([]);
});
