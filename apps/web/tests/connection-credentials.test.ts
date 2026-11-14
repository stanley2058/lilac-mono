import { afterEach, expect, test } from "bun:test";
import {
  prepareWebConnection,
  readConnectionToken,
  registerConnectionCredentials,
  requireConnectionCredentials,
} from "../src/connection-credentials";

afterEach(() => {
  requireConnectionCredentials(async () => false);
});

test("connection preparation awaits the active credentials and ignores stale cleanup", async () => {
  const old = registerConnectionCredentials(async () => {
    throw new Error("Stale provider");
  });
  const token = Promise.withResolvers<string>();
  const stop = registerConnectionCredentials(() => token.promise);
  old();
  let ready = false;
  const preparing = prepareWebConnection().then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  token.resolve("fresh-token");
  await preparing;
  expect(ready).toBe(true);
  expect(await readConnectionToken()).toBe("fresh-token");
  stop();
  expect(await readConnectionToken()).toBeUndefined();
  await prepareWebConnection();
});

test("credential refresh errors reach connection retry without sending unauthenticated requests", async () => {
  const stop = registerConnectionCredentials(async () => {
    throw new Error("Offline");
  });
  await expect(prepareWebConnection()).rejects.toThrow("Offline");
  stop();
});

test("a rejected cookie retry waits for the provider instead of signing out", async () => {
  const auth = Promise.withResolvers<boolean>();
  requireConnectionCredentials(() => auth.promise);
  await prepareWebConnection();
  expect(await readConnectionToken()).toBeUndefined();
  const requests: boolean[] = [];
  const retry = prepareWebConnection({ fresh: true });
  auth.resolve(true);
  const stop = registerConnectionCredentials(async ({ fresh }) => {
    requests.push(fresh);
    return "provider-token";
  });
  await retry;
  expect(requests).toEqual([true]);
  expect(await readConnectionToken()).toBe("provider-token");
  expect(requests).toEqual([true, false]);
  stop();
});

test("password sessions retry immediately with their cookie", async () => {
  requireConnectionCredentials(async () => false);
  await prepareWebConnection({ fresh: true });
  expect(await readConnectionToken()).toBeUndefined();
});

test("a superseded retry settles without fetching a token when the provider loads", async () => {
  requireConnectionCredentials(async () => true);
  const requests: boolean[] = [];
  let superseded = false;
  const stale = prepareWebConnection({ fresh: true }).then(() => {
    superseded = true;
  });
  const latest = prepareWebConnection({ fresh: true });
  await stale;
  expect(superseded).toBe(true);
  expect(requests).toEqual([]);
  const stop = registerConnectionCredentials(async ({ fresh }) => {
    requests.push(fresh);
    return "provider-token";
  });
  await latest;
  expect(requests).toEqual([true]);
  stop();
});
