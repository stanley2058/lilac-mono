import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultNativeSurfaceConfig } from "../../../../../packages/utils/core-config/types";
import {
  canonicalNativeAuthRequest,
  openNativeInstallation,
  type NativeInstallation,
} from "./installation";

const directories: string[] = [];
const installations: NativeInstallation[] = [];
afterEach(async () => {
  for (const installation of installations.splice(0)) installation.store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lilac-native-installation-"));
  directories.push(dataDir);
  const config = {
    ...defaultNativeSurfaceConfig(),
    enabled: true,
    installationId: "fixture",
    publicUrl: "https://lilac.example",
    allowedOrigins: ["https://lilac.example"],
  };
  const secrets = {
    localUsername: "owner",
    localPasswordHash: await Bun.password.hash("fixture-password", {
      algorithm: "argon2id",
      memoryCost: 4096,
      timeCost: 1,
    }),
    sessionSecret: "fixture-session-key-at-least-32-bytes",
  };
  return { dataDir, config, secrets };
}

test("installation creates fixed owner and service user, and canonical HTTPS auth works behind local proxy", async () => {
  const options = await fixture();
  const installation = (await openNativeInstallation(options)).unwrap();
  installations.push(installation);
  expect(installation.store.getUser("owner").unwrap().role).toBe("owner");
  expect(installation.store.getUser("lilac").unwrap().role).toBe("service");
  const request = new Request("http://127.0.0.1:8787/api/auth/login", {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa("owner:fixture-password")}`,
      origin: "https://lilac.example",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "http",
    },
  });
  const login = (await installation.login!(request, "loopback")).unwrap();
  expect(login.setCookie).toContain("; Secure");
  const resource = new Request("http://127.0.0.1:8787/api/resources/file", {
    headers: { cookie: login.setCookie.split(";")[0]! },
  });
  expect((await installation.auth.authenticate(resource)).unwrap().userId).toBe("owner");
  const wrongOrigin = new Request(request, {
    headers: {
      authorization: request.headers.get("authorization")!,
      origin: "https://attacker.example",
    },
  });
  expect((await installation.login!(wrongOrigin, "loopback")).isErr()).toBe(true);
});

test("canonical auth URL uses installation URL and preserves actual Origin while dropping forwarded headers", () => {
  const request = new Request("http://internal:8787/api/socket?checkpoint=1", {
    headers: {
      host: "evil.example",
      origin: "https://caller.example",
      forwarded: "host=evil.example;proto=http",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
      "x-forwarded-port": "80",
    },
  });
  const canonical = canonicalNativeAuthRequest(request, "https://lilac.example");
  expect(canonical.url).toBe("https://lilac.example/api/socket?checkpoint=1");
  expect(canonical.headers.get("host")).toBe("lilac.example");
  expect(canonical.headers.get("origin")).toBe("https://caller.example");
  expect(canonical.headers.has("forwarded")).toBe(false);
  expect([...canonical.headers.keys()].some((key) => key.startsWith("x-forwarded-"))).toBe(false);
  expect(request.url).toBe("http://internal:8787/api/socket?checkpoint=1");
});

test("invalid local secrets fail before creating storage", async () => {
  const options = await fixture();
  for (const secrets of [
    { ...options.secrets, sessionSecret: "short" },
    { ...options.secrets, localPasswordHash: "plaintext" },
    { ...options.secrets, localPasswordHash: "$argon2id$invalid" },
  ]) {
    const result = await openNativeInstallation({ ...options, secrets });
    expect(result.isErr()).toBe(true);
    expect(await Bun.file(path.join(options.dataDir, "native-surface.db")).exists()).toBe(false);
  }
});

test("Clerk browser installation does not require a TUI OAuth application", async () => {
  const options = await fixture();
  const installation = (
    await openNativeInstallation({
      ...options,
      config: {
        ...options.config,
        auth: {
          provider: "clerk",
          ownerId: "owner",
          ownerProviderUserId: "user_fixture",
          clerkIssuer: "https://fixture.clerk.accounts.dev",
        },
      },
      secrets: {
        clerkSecretKey: "sk_test_fixture",
        clerkPublishableKey: `pk_test_${btoa("fixture.clerk.accounts.dev$")}`,
      },
    })
  ).unwrap();
  installations.push(installation);
  expect(installation.login).toBeUndefined();
  expect(installation.clerk).toBeDefined();
  expect(installation.store.findUserByProviderId("user_fixture").unwrap()?.id).toBe("owner");
});

test("reopening an installation preserves agent and account profiles", async () => {
  const options = await fixture();
  const first = (await openNativeInstallation(options)).unwrap();
  first.store
    .setAgentIdentity("owner", {
      displayName: "Garden",
      avatar: {
        mediaType: "image/png",
        blob: {
          version: 1,
          objectId: `b1_${"a".repeat(32)}`,
          sha256: "b".repeat(64),
          byteLength: 42,
        },
      },
    })
    .unwrap();
  const avatar = first.store.getUser("lilac").unwrap().avatar;
  first.store.setUserProfile("owner", { displayName: "River", avatar }).unwrap();
  first.store.close();
  const reopened = (await openNativeInstallation(options)).unwrap();
  installations.push(reopened);
  expect(reopened.store.getUser("owner").unwrap()).toMatchObject({ displayName: "River", avatar });
  expect(reopened.store.getUser("lilac").unwrap()).toMatchObject({
    displayName: "Garden",
    avatar: { mediaType: "image/png", blob: { byteLength: 42 } },
  });
});

test("operator-only installation needs no public credentials and preserves the owner when web is enabled", async () => {
  const options = await fixture();
  const first = (
    await openNativeInstallation({
      ...options,
      config: { ...options.config, enabled: false, installationId: undefined },
      secrets: { operatorTokenSha256: "a".repeat(64) },
    })
  ).unwrap();
  first.store
    .upsertUser({ ...first.store.getUser("owner").unwrap(), displayName: "Preserved owner" })
    .unwrap();
  expect(
    (await first.auth.authenticate(new Request("http://localhost/api/bootstrap"))).isErr(),
  ).toBe(true);
  first.store.close();
  const web = (await openNativeInstallation(options)).unwrap();
  installations.push(web);
  expect(web.store.getUser("owner").unwrap().displayName).toBe("Preserved owner");
  expect(web.store.getUser("owner").unwrap().providerId).toBe("owner");
});
