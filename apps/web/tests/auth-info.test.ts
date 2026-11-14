import { expect, test } from "bun:test";
import { Result } from "better-result";
import { clerkPublishableKey, createAuthInfoLoader, providerTokenRequired } from "../src/auth-info";
import { WebRequestFailed, type AuthInfo } from "../src/http";

test("a failed auth settings read is retried and a loaded one is kept", async () => {
  const replies = [
    Result.err(
      new WebRequestFailed({ code: "unavailable", message: "Could not connect to Lilac" }),
    ),
    Result.ok<AuthInfo>({ provider: "clerk", publishableKey: "pk_test" }),
  ];
  let reads = 0;
  const loader = createAuthInfoLoader(async () => replies[reads++]!);
  let notified = 0;
  loader.subscribe(() => notified++);
  expect((await loader.load()).isErr()).toBe(true);
  expect(loader.getSnapshot()).toEqual({ error: "Could not connect to Lilac" });
  expect((await loader.load()).isOk()).toBe(true);
  await loader.load();
  expect(reads).toBe(2);
  expect(notified).toBe(2);
  expect(clerkPublishableKey(loader.getSnapshot().auth)).toBe("pk_test");
});

test("concurrent reads share one request", async () => {
  const reply = Promise.withResolvers<Result<AuthInfo, WebRequestFailed>>();
  let reads = 0;
  const loader = createAuthInfoLoader(() => {
    reads++;
    return reply.promise;
  });
  const first = loader.load();
  const second = loader.load();
  reply.resolve(Result.ok({ provider: "local" }));
  expect((await first).isOk()).toBe(true);
  expect((await second).isOk()).toBe(true);
  expect(reads).toBe(1);
  expect(clerkPublishableKey(loader.getSnapshot().auth)).toBeUndefined();
});

test("only unreadable or Clerk settings make a cookie retry wait for a provider token", async () => {
  const failed = new WebRequestFailed({ code: "unavailable", message: "Could not connect" });
  const reply = (value: Result<AuthInfo, WebRequestFailed>) => ({ load: async () => value });
  expect(await providerTokenRequired(reply(Result.err(failed)))).toBe(true);
  expect(
    await providerTokenRequired(reply(Result.ok({ provider: "clerk", publishableKey: "pk" }))),
  ).toBe(true);
  expect(await providerTokenRequired(reply(Result.ok({ provider: "local" })))).toBe(false);
});
